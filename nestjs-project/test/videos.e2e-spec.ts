import { randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
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
    await cleanAllTables(dataSource);
    await app.close();
  });

  beforeEach(async () => {
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
});
