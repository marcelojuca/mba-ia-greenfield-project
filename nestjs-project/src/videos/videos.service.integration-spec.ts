import { randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { presignedRequest, uploadFileToParts } from '../test/presigned-request';
import {
  createChannelOwner,
  createVideoTestingModule,
} from '../test/video-test-module';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingProducer } from './video-processing.producer';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosService (integration — PostgreSQL + MinIO + Redis)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let videos: Repository<Video>;
  let queue: Queue;
  let owner: { userId: string; channelId: string };

  beforeAll(async () => {
    module = await createVideoTestingModule([VideosModule]);
    dataSource = module.get(DataSource);
    service = module.get(VideosService);
    storage = module.get(StorageService);
    videos = dataSource.getRepository(Video);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    owner = await createChannelOwner(dataSource);
    await queue.obliterate({ force: true });
  });

  describe('initiateUpload', () => {
    it('persists a draft with an open multipart upload owned by the channel', async () => {
      const session = await service.initiateUpload(owner.userId, {
        fileName: 'Trip to Rio.mp4',
        fileSize: 2048,
        contentType: 'video/mp4',
      });

      const saved = await videos.findOneByOrFail({ id: session.video.id });
      expect(saved).toMatchObject({
        status: VideoStatus.DRAFT,
        channel_id: owner.channelId,
        title: 'Trip to Rio',
        size_bytes: 2048,
        mime_type: 'video/mp4',
        storage_key: `videos/${session.video.id}/source`,
        public_id: session.video.public_id,
      });
      expect(saved.upload_id).toEqual(expect.any(String));
      await storage.abortMultipartUpload(saved.storage_key, saved.upload_id!);
    });

    it('returns part URLs that accept direct uploads to storage', async () => {
      const session = await service.initiateUpload(owner.userId, {
        fileName: 'clip.mp4',
        fileSize: 1024,
        contentType: 'video/mp4',
      });

      const res = await presignedRequest(session.parts[0].url, {
        method: 'PUT',
        body: randomBytes(1024),
      });

      expect(res.status).toBe(200);
      const parts = await storage.listUploadedParts(
        session.video.storage_key,
        session.video.upload_id!,
      );
      expect(parts).toHaveLength(1);
      await storage.abortMultipartUpload(
        session.video.storage_key,
        session.video.upload_id!,
      );
    });

    it('gives every video a distinct public id', async () => {
      const input = {
        fileName: 'a.mp4',
        fileSize: 10,
        contentType: 'video/mp4',
      };

      const first = await service.initiateUpload(owner.userId, input);
      const second = await service.initiateUpload(owner.userId, input);

      expect(first.video.public_id).not.toBe(second.video.public_id);
      for (const s of [first, second]) {
        await storage.abortMultipartUpload(
          s.video.storage_key,
          s.video.upload_id!,
        );
      }
    });
  });
  describe('completeUpload', () => {
    async function uploadDraft(file: Buffer) {
      const session = await service.initiateUpload(owner.userId, {
        fileName: 'clip.mp4',
        fileSize: file.length,
        contentType: 'video/mp4',
      });
      return session;
    }

    it('assembles the object, moves the video to processing and enqueues a job', async () => {
      const file = randomBytes(4096);
      const session = await uploadDraft(file);
      await uploadFileToParts(session.parts, session.partSize, file);

      const video = await service.completeUpload(
        owner.userId,
        session.video.public_id,
      );

      expect(video.status).toBe(VideoStatus.PROCESSING);
      const saved = await videos.findOneByOrFail({ id: video.id });
      expect(saved.status).toBe(VideoStatus.PROCESSING);
      expect(saved.upload_id).toBeNull();
      await expect(storage.headObject(saved.storage_key)).resolves.toEqual({
        size: 4096,
      });
      const job = await queue.getJob(video.id);
      expect(job?.data).toEqual({ videoId: video.id });
      await storage.deleteObject(saved.storage_key);
    });

    it('keeps the draft when not every part was uploaded', async () => {
      const session = await uploadDraft(randomBytes(64));

      await expect(
        service.completeUpload(owner.userId, session.video.public_id),
      ).rejects.toMatchObject({ errorCode: 'UPLOAD_INCOMPLETE' });

      const saved = await videos.findOneByOrFail({ id: session.video.id });
      expect(saved.status).toBe(VideoStatus.DRAFT);
      expect(saved.upload_id).toBe(session.video.upload_id);
      await storage.abortMultipartUpload(saved.storage_key, saved.upload_id!);
    });

    it('reverts to draft when the queue rejects the job, and a retry succeeds', async () => {
      const file = randomBytes(2048);
      const session = await uploadDraft(file);
      await uploadFileToParts(session.parts, session.partSize, file);
      const producer = module.get(VideoProcessingProducer);
      jest
        .spyOn(producer, 'enqueue')
        .mockRejectedValueOnce(new Error('queue unavailable'));

      await expect(
        service.completeUpload(owner.userId, session.video.public_id),
      ).rejects.toThrow('queue unavailable');
      const reverted = await videos.findOneByOrFail({ id: session.video.id });
      expect(reverted.status).toBe(VideoStatus.DRAFT);

      const retried = await service.completeUpload(
        owner.userId,
        session.video.public_id,
      );
      expect(retried.status).toBe(VideoStatus.PROCESSING);
      await expect(queue.getJob(session.video.id)).resolves.toBeDefined();
      await storage.deleteObject(session.video.storage_key);
    });

    it('fails the video when the stored size differs from the declared size', async () => {
      const session = await uploadDraft(randomBytes(1000));
      // The client sends more bytes than declared — presigned parts cannot cap size.
      await uploadFileToParts(
        session.parts,
        session.partSize,
        randomBytes(1500),
      );

      await expect(
        service.completeUpload(owner.userId, session.video.public_id),
      ).rejects.toMatchObject({ errorCode: 'UPLOAD_SIZE_MISMATCH' });

      const saved = await videos.findOneByOrFail({ id: session.video.id });
      expect(saved.status).toBe(VideoStatus.FAILED);
      expect(saved.processing_error).toContain('does not match');
      await expect(storage.headObject(saved.storage_key)).resolves.toBeNull();
    });
  });
});
