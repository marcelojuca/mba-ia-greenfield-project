import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  presignedRequest,
  uploadFileToParts,
} from '../src/test/presigned-request';
import {
  createCorruptFixture,
  createVideoFixture,
} from '../src/test/video-fixture';
import { Video } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';
import { WorkerModule } from '../src/worker/worker.module';
import {
  createConfirmedUser,
  createE2eApp,
  deleteStoredVideoObjects,
  type TestUser,
} from './helpers/e2e-app';

const MIB = 1024 * 1024;
const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 30_000;

/**
 * The whole phase over real infrastructure: HTTP upload handshake → direct
 * part uploads to MinIO → completion → BullMQ → video worker (ffprobe/ffmpeg)
 * → streaming/download. API and worker run in this process on the test queue
 * prefix, so the long-running video-worker container never takes these jobs.
 */
describe('Video pipeline (e2e)', () => {
  let app: INestApplication<App>;
  let worker: INestApplicationContext;
  let dataSource: DataSource;
  let queue: Queue;
  let user: TestUser;

  beforeAll(async () => {
    // Smallest legal S3 part size, so a ~8 MB fixture uploads in two parts.
    process.env.UPLOAD_PART_SIZE_BYTES = String(5 * MIB);
    app = await createE2eApp();
    worker = await NestFactory.createApplicationContext(WorkerModule, {
      logger: ['error'],
    });
    dataSource = app.get(DataSource);
    queue = app.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 60_000);

  afterAll(async () => {
    await deleteStoredVideoObjects(app);
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    await worker.close();
    await app.close();
  });

  beforeEach(async () => {
    await deleteStoredVideoObjects(app);
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    user = await createConfirmedUser(app);
  });

  async function uploadAndComplete(
    file: Buffer,
    fileName = 'pipeline.mp4',
  ): Promise<{ id: string; partCount: number }> {
    const start = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ fileName, fileSize: file.length, contentType: 'video/mp4' })
      .expect(201);
    await uploadFileToParts(
      start.body.upload.parts,
      start.body.upload.partSize,
      file,
    );
    await request(app.getHttpServer())
      .post(`/videos/${start.body.id}/upload/complete`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(202);
    return { id: start.body.id, partCount: start.body.upload.partCount };
  }

  async function waitForStatus(
    id: string,
    statuses: string[],
  ): Promise<Record<string, any>> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${id}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      if (statuses.includes(res.body.status)) return res.body;
      if (Date.now() > deadline) {
        throw new Error(`Video ${id} still ${res.body.status} after timeout`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  it('processes a multi-part upload automatically and serves it by streaming and download', async () => {
    const file = await createVideoFixture({
      durationSeconds: 4,
      width: 640,
      height: 360,
      bitrate: '16M',
    });
    expect(file.length).toBeGreaterThan(5 * MIB);

    const { id, partCount } = await uploadAndComplete(file);
    const video = await waitForStatus(id, ['ready', 'failed']);

    expect(partCount).toBeGreaterThan(1);
    expect(video).toMatchObject({
      status: 'ready',
      metadata: {
        width: 640,
        height: 360,
        videoCodec: 'h264',
        audioCodec: 'aac',
      },
      processingError: null,
    });
    expect(video.durationSeconds).toBeCloseTo(4, 0);

    const anonymous = await request(app.getHttpServer())
      .get(`/videos/${id}`)
      .expect(200);
    expect(anonymous.body.status).toBe('ready');

    const thumb = await request(app.getHttpServer())
      .get(`/videos/${id}/thumbnail`)
      .expect(302);
    const jpeg = await presignedRequest(thumb.headers.location);
    expect(jpeg.status).toBe(200);
    expect(jpeg.body.subarray(0, 2).toString('hex')).toBe('ffd8');

    const stream = await request(app.getHttpServer())
      .get(`/videos/${id}/stream`)
      .expect(302);
    const lastKib = await presignedRequest(stream.headers.location, {
      headers: { range: `bytes=${file.length - 1024}-` },
    });
    expect(lastKib.status).toBe(206);
    expect(lastKib.body.equals(file.subarray(file.length - 1024))).toBe(true);

    const download = await request(app.getHttpServer())
      .get(`/videos/${id}/download`)
      .expect(302);
    const copy = await presignedRequest(download.headers.location);
    expect(copy.headers['content-disposition']).toContain('attachment');
    expect(copy.body.equals(file)).toBe(true);
  }, 90_000);

  it('marks an undecodable upload as failed without retries', async () => {
    const { id } = await uploadAndComplete(createCorruptFixture(), 'bad.mp4');

    const video = await waitForStatus(id, ['ready', 'failed']);

    expect(video.status).toBe('failed');
    expect(video.processingError).toEqual(expect.any(String));
    expect(video.processingError).not.toHaveLength(0);
    // UnrecoverableError: the job failed on its first attempt, no retries.
    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: id });
    const job = await queue.getJob(row.id);
    expect(job?.attemptsMade).toBe(1);
  }, 60_000);

  it('gives each upload its own unique URL', async () => {
    const file = await createVideoFixture({ durationSeconds: 1 });

    const first = await uploadAndComplete(file);
    const second = await uploadAndComplete(file);

    expect(first.id).not.toBe(second.id);
    const [a, b] = await Promise.all([
      waitForStatus(first.id, ['ready', 'failed']),
      waitForStatus(second.id, ['ready', 'failed']),
    ]);
    expect(a.url).not.toBe(b.url);
    expect([a.status, b.status]).toEqual(['ready', 'ready']);
  }, 60_000);
});
