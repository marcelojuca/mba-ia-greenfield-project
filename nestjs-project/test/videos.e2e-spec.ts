import { randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  presignedRequest,
  uploadFileToParts,
} from '../src/test/presigned-request';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';
import {
  createConfirmedUser,
  createE2eApp,
  deleteStoredVideoObjects,
  type TestUser,
} from './helpers/e2e-app';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let owner: TestUser;
  let queue: Queue;

  beforeAll(async () => {
    app = await createE2eApp();
    dataSource = app.get(DataSource);
    queue = app.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await deleteStoredVideoObjects(app);
    await cleanAllTables(dataSource);
    await app.close();
  });

  beforeEach(async () => {
    await deleteStoredVideoObjects(app);
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    owner = await createConfirmedUser(app);
  });

  const startUpload = (
    user: TestUser,
    body: Record<string, unknown> = {
      fileName: 'Trip to Rio.mp4',
      fileSize: 1024,
      contentType: 'video/mp4',
    },
  ) =>
    request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send(body);

  describe('POST /videos', () => {
    it('returns 201 with the draft and presigned part URLs', async () => {
      const res = await startUpload(owner).expect(201);

      expect(res.body).toMatchObject({
        title: 'Trip to Rio',
        status: 'draft',
        upload: { partCount: 1, partSize: expect.any(Number) },
      });
      expect(res.body.id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(res.body.url).toMatch(new RegExp(`/videos/${res.body.id}$`));
      expect(res.body.upload.parts).toHaveLength(1);
      expect(res.body.upload.parts[0].url).toContain('partNumber=1');
      const saved = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: res.body.id });
      expect(saved.status).toBe(VideoStatus.DRAFT);
    });

    it('lets the client PUT the bytes straight to object storage', async () => {
      const res = await startUpload(owner).expect(201);

      const put = await presignedRequest(res.body.upload.parts[0].url, {
        method: 'PUT',
        body: randomBytes(1024),
      });

      expect(put.status).toBe(200);
      expect(put.headers.etag).toBeDefined();
    });

    it('returns 400 VALIDATION_ERROR for a non-video content type', async () => {
      const res = await startUpload(owner, {
        fileName: 'photo.png',
        fileSize: 10,
        contentType: 'image/png',
      }).expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VIDEO_TOO_LARGE above the configured maximum', async () => {
      const res = await startUpload(owner, {
        fileName: 'huge.mp4',
        fileSize: 10 * 1024 ** 3 + 1,
        contentType: 'video/mp4',
      }).expect(400);

      expect(res.body.error).toBe('VIDEO_TOO_LARGE');
    });

    it('accepts exactly 10 GiB and returns 103 part URLs', async () => {
      const res = await startUpload(owner, {
        fileName: 'ten-gigs.mp4',
        fileSize: 10 * 1024 ** 3,
        contentType: 'video/mp4',
      }).expect(201);

      expect(res.body.upload.partCount).toBe(103);
      expect(res.body.upload.parts).toHaveLength(103);
    });

    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({ fileName: 'a.mp4', fileSize: 1, contentType: 'video/mp4' })
        .expect(401);
    });
  });
  describe('POST /videos/:id/upload/complete', () => {
    async function uploadAll(user: TestUser, file: Buffer) {
      const res = await startUpload(user, {
        fileName: 'clip.mp4',
        fileSize: file.length,
        contentType: 'video/mp4',
      }).expect(201);
      await uploadFileToParts(
        res.body.upload.parts,
        res.body.upload.partSize,
        file,
      );
      return res.body.id as string;
    }

    const complete = (user: TestUser, id: string) =>
      request(app.getHttpServer())
        .post(`/videos/${id}/upload/complete`)
        .set('Authorization', `Bearer ${user.accessToken}`);

    it('returns 202 with the video in processing', async () => {
      const id = await uploadAll(owner, randomBytes(2048));

      const res = await complete(owner, id).expect(202);

      expect(res.body).toMatchObject({
        id,
        status: 'processing',
        sizeBytes: 2048,
        originalFilename: 'clip.mp4',
        streamUrl: null,
        channel: { nickname: expect.any(String) },
      });
    });

    it('returns 400 UPLOAD_INCOMPLETE before the parts are uploaded', async () => {
      const start = await startUpload(owner).expect(201);

      const res = await complete(owner, start.body.id).expect(400);

      expect(res.body.error).toBe('UPLOAD_INCOMPLETE');
    });

    it('returns 404 VIDEO_NOT_FOUND for another user video', async () => {
      const id = await uploadAll(owner, randomBytes(512));
      const intruder = await createConfirmedUser(app);

      const res = await complete(intruder, id).expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 409 VIDEO_NOT_DRAFT when completed twice', async () => {
      const id = await uploadAll(owner, randomBytes(512));
      await complete(owner, id).expect(202);

      const res = await complete(owner, id).expect(409);

      expect(res.body.error).toBe('VIDEO_NOT_DRAFT');
    });

    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos/abcdefghijk/upload/complete')
        .expect(401);
    });
  });
  describe('reading, streaming and downloading', () => {
    const FILE = randomBytes(4096);

    /** Uploads through the API, then applies the worker's end state. */
    async function readyVideo(user: TestUser): Promise<string> {
      const start = await startUpload(user, {
        fileName: 'Viagem ao Rio.mp4',
        fileSize: FILE.length,
        contentType: 'video/mp4',
      }).expect(201);
      await uploadFileToParts(
        start.body.upload.parts,
        start.body.upload.partSize,
        FILE,
      );
      await request(app.getHttpServer())
        .post(`/videos/${start.body.id}/upload/complete`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(202);

      const repo = dataSource.getRepository(Video);
      const video = await repo.findOneByOrFail({ public_id: start.body.id });
      const thumbnailKey = `thumbnails/${video.id}.jpg`;
      await app
        .get(StorageService)
        .putObject(thumbnailKey, Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
      await repo.update(
        { id: video.id },
        {
          status: VideoStatus.READY,
          duration_seconds: 3,
          metadata: {
            width: 320,
            height: 240,
            videoCodec: 'h264',
            audioCodec: 'aac',
            formatName: 'mp4',
            bitRate: 1000,
            frameRate: 25,
          },
          thumbnail_key: thumbnailKey,
          processed_at: new Date(),
        },
      );
      return start.body.id as string;
    }

    async function draftVideo(user: TestUser): Promise<string> {
      const res = await startUpload(user).expect(201);
      return res.body.id as string;
    }

    it('GET /videos/:id returns a ready video to anonymous users', async () => {
      const id = await readyVideo(owner);

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}`)
        .expect(200);

      expect(res.body).toMatchObject({
        id,
        status: 'ready',
        durationSeconds: 3,
        metadata: { width: 320, height: 240 },
        processingError: null,
      });
      expect(res.body.url).toMatch(new RegExp(`/videos/${id}$`));
      expect(res.body.streamUrl).toBe(`${res.body.url}/stream`);
      expect(res.body.downloadUrl).toBe(`${res.body.url}/download`);
      expect(res.body.thumbnailUrl).toBe(`${res.body.url}/thumbnail`);
    });

    it('GET /videos/:id hides drafts from anonymous users but not from the owner', async () => {
      const id = await draftVideo(owner);

      const anonymous = await request(app.getHttpServer())
        .get(`/videos/${id}`)
        .expect(404);
      const asOwner = await request(app.getHttpServer())
        .get(`/videos/${id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect(anonymous.body.error).toBe('VIDEO_NOT_FOUND');
      expect(asOwner.body).toMatchObject({
        id,
        status: 'draft',
        streamUrl: null,
      });
    });

    it('GET /videos/:id hides drafts from other authenticated users', async () => {
      const id = await draftVideo(owner);
      const other = await createConfirmedUser(app);

      await request(app.getHttpServer())
        .get(`/videos/${id}`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(404);
    });

    it('GET /videos/:id/stream redirects to storage, which serves byte ranges', async () => {
      const id = await readyVideo(owner);

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .expect(302);
      const media = await presignedRequest(res.headers.location, {
        headers: { range: 'bytes=0-1023' },
      });

      expect(res.headers.location).toContain('X-Amz-Signature');
      expect(media.status).toBe(206);
      expect(media.body.length).toBe(1024);
      expect(media.body.equals(FILE.subarray(0, 1024))).toBe(true);
      expect(media.headers['content-type']).toBe('video/mp4');
    });

    it('GET /videos/:id/download redirects to an attachment with the original name', async () => {
      const id = await readyVideo(owner);

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/download`)
        .expect(302);
      const file = await presignedRequest(res.headers.location);

      expect(file.status).toBe(200);
      expect(file.headers['content-disposition']).toContain(
        'attachment; filename="Viagem ao Rio.mp4"',
      );
      expect(file.body.equals(FILE)).toBe(true);
    });

    it('GET /videos/:id/thumbnail redirects to the JPEG', async () => {
      const id = await readyVideo(owner);

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/thumbnail`)
        .expect(302);
      const image = await presignedRequest(res.headers.location);

      expect(image.status).toBe(200);
      expect(image.headers['content-type']).toBe('image/jpeg');
    });

    it('GET /videos/:id/stream returns 409 VIDEO_NOT_READY to the owner of a processing video', async () => {
      const start = await startUpload(owner, {
        fileName: 'clip.mp4',
        fileSize: 512,
        contentType: 'video/mp4',
      }).expect(201);
      await uploadFileToParts(
        start.body.upload.parts,
        start.body.upload.partSize,
        randomBytes(512),
      );
      await request(app.getHttpServer())
        .post(`/videos/${start.body.id}/upload/complete`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(202);

      const res = await request(app.getHttpServer())
        .get(`/videos/${start.body.id}/stream`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(409);

      expect(res.body.error).toBe('VIDEO_NOT_READY');
    });

    it('GET /videos/:id/download returns 404 for anonymous users of a draft', async () => {
      const id = await draftVideo(owner);

      await request(app.getHttpServer())
        .get(`/videos/${id}/download`)
        .expect(404);
    });

    it('GET /videos/:id returns 404 VIDEO_NOT_FOUND for an unknown id', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/unknownid00')
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('does not rate-limit playback requests', async () => {
      const id = await readyVideo(owner);

      for (let i = 0; i < 15; i++) {
        await request(app.getHttpServer())
          .get(`/videos/${id}/stream`)
          .expect(302);
      }
    });
  });
});
