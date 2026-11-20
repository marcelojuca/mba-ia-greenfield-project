import { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingProducer } from './video-processing.producer';
import {
  ChannelNotFoundException,
  VideoTooLargeException,
} from './videos.exceptions';
import { VideosService } from './videos.service';

const MIB = 1024 ** 2;
const USER_ID = 'user-1';
const CHANNEL = { id: 'channel-1', user_id: USER_ID };

const STORAGE_CONFIG: ConfigType<typeof storageConfig> = {
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://localhost:9000',
  region: 'us-east-1',
  accessKey: 'key',
  secretKey: 'secret',
  bucket: 'bucket',
  uploadMaxSizeBytes: 10 * 1024 ** 3,
  uploadPartSizeBytes: 100 * MIB,
  uploadUrlExpiresSeconds: 86400,
  downloadUrlExpiresSeconds: 3600,
};

function uniqueViolation(column: string): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error('duplicate'));
  return Object.assign(err, {
    code: '23505',
    detail: `Key (${column})=(x) already exists.`,
  });
}

async function buildVideosService() {
  const videoRepository = {
    create: jest.fn((input: Partial<Video>) => ({ ...input }) as Video),
    insert: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    save: jest.fn(),
  };
  const channelsService = {
    findByUserId: jest.fn().mockResolvedValue(CHANNEL),
  };
  const storageService = {
    createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
    presignUploadPart: jest.fn(
      (_key: string, _uploadId: string, part: number) =>
        Promise.resolve(`https://storage/part-${part}`),
    ),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    listUploadedParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn().mockResolvedValue(undefined),
    presignGetObject: jest.fn(),
  };
  const producer = { enqueue: jest.fn().mockResolvedValue(undefined) };

  const module = await Test.createTestingModule({
    providers: [
      VideosService,
      { provide: getRepositoryToken(Video), useValue: videoRepository },
      { provide: ChannelsService, useValue: channelsService },
      { provide: StorageService, useValue: storageService },
      { provide: VideoProcessingProducer, useValue: producer },
      { provide: storageConfig.KEY, useValue: STORAGE_CONFIG },
    ],
  }).compile();

  return {
    service: module.get(VideosService),
    videoRepository,
    channelsService,
    storageService,
    producer,
  };
}

describe('VideosService', () => {
  describe('initiateUpload', () => {
    const input = {
      fileName: 'Trip to Rio.mp4',
      fileSize: 250 * MIB,
      contentType: 'video/mp4',
    };

    it('should pre-register a draft and return one presigned URL per part', async () => {
      const { service, videoRepository, storageService } =
        await buildVideosService();

      const session = await service.initiateUpload(USER_ID, input);

      expect(session.video.status).toBe(VideoStatus.DRAFT);
      expect(session.video.channel_id).toBe(CHANNEL.id);
      expect(session.video.storage_key).toBe(
        `videos/${session.video.id}/source`,
      );
      expect(session.video.upload_id).toBe('upload-1');
      expect(session.partCount).toBe(3);
      expect(session.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
      expect(storageService.presignUploadPart).toHaveBeenCalledTimes(3);
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: session.video.id },
        { upload_id: 'upload-1' },
      );
    });

    it('should default the title to the file name without extension', async () => {
      const { service } = await buildVideosService();

      const session = await service.initiateUpload(USER_ID, input);

      expect(session.video.title).toBe('Trip to Rio');
    });

    it('should keep an explicit title and truncate long titles to 100 chars', async () => {
      const { service } = await buildVideosService();

      const explicit = await service.initiateUpload(USER_ID, {
        ...input,
        title: '  Carnival  ',
      });
      const long = await service.initiateUpload(USER_ID, {
        ...input,
        fileName: `${'a'.repeat(150)}.mp4`,
      });

      expect(explicit.video.title).toBe('Carnival');
      expect(long.video.title).toHaveLength(100);
    });

    it('should reject a declared size above the maximum without persisting', async () => {
      const { service, videoRepository } = await buildVideosService();

      await expect(
        service.initiateUpload(USER_ID, {
          ...input,
          fileSize: STORAGE_CONFIG.uploadMaxSizeBytes + 1,
        }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
      expect(videoRepository.insert).not.toHaveBeenCalled();
    });

    it('should raise ChannelNotFoundException when the user has no channel', async () => {
      const { service, channelsService } = await buildVideosService();
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(
        service.initiateUpload(USER_ID, input),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);
    });

    it('should regenerate the public id after a unique collision', async () => {
      const { service, videoRepository } = await buildVideosService();
      videoRepository.insert
        .mockRejectedValueOnce(uniqueViolation('public_id'))
        .mockResolvedValueOnce(undefined);

      const session = await service.initiateUpload(USER_ID, input);

      expect(videoRepository.insert).toHaveBeenCalledTimes(2);
      expect(session.video.public_id).toHaveLength(11);
    });

    it('should not retry unrelated insert errors', async () => {
      const { service, videoRepository } = await buildVideosService();
      videoRepository.insert.mockRejectedValue(uniqueViolation('id'));

      await expect(service.initiateUpload(USER_ID, input)).rejects.toThrow(
        QueryFailedError,
      );
      expect(videoRepository.insert).toHaveBeenCalledTimes(1);
    });

    it('should abort the multipart upload and delete the draft when presigning fails', async () => {
      const { service, videoRepository, storageService } =
        await buildVideosService();
      storageService.presignUploadPart.mockRejectedValue(new Error('boom'));

      await expect(service.initiateUpload(USER_ID, input)).rejects.toThrow(
        'boom',
      );
      expect(storageService.abortMultipartUpload).toHaveBeenCalled();
      expect(videoRepository.delete).toHaveBeenCalled();
    });
  });
});
