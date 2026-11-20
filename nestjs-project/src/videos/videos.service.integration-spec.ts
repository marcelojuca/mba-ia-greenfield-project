import { randomBytes } from 'node:crypto';
import { TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { presignedRequest } from '../test/presigned-request';
import {
  createChannelOwner,
  createVideoTestingModule,
} from '../test/video-test-module';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosService (integration — PostgreSQL + MinIO + Redis)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let videos: Repository<Video>;
  let owner: { userId: string; channelId: string };

  beforeAll(async () => {
    module = await createVideoTestingModule([VideosModule]);
    dataSource = module.get(DataSource);
    service = module.get(VideosService);
    storage = module.get(StorageService);
    videos = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    owner = await createChannelOwner(dataSource);
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
});
