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
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotDraftException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoTooLargeException,
} from './videos.exceptions';
import { attachmentDisposition, VideosService } from './videos.service';

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
    update: jest.fn().mockResolvedValue({ affected: 1 }),
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
  describe('completeUpload', () => {
    const PUBLIC_ID = 'abcdefghijk';

    function draftVideo(overrides: Partial<Video> = {}): Video {
      return {
        id: 'video-1',
        public_id: PUBLIC_ID,
        status: VideoStatus.DRAFT,
        storage_key: 'videos/video-1/source',
        upload_id: 'upload-1',
        size_bytes: 150,
        channel: { id: CHANNEL.id, user_id: USER_ID },
        ...overrides,
      } as Video;
    }

    async function setup(video: Video | null = draftVideo()) {
      const ctx = await buildVideosService();
      ctx.videoRepository.findOne.mockResolvedValue(video);
      ctx.storageService.headObject
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ size: 150 });
      ctx.storageService.listUploadedParts.mockResolvedValue([
        { partNumber: 1, etag: '"a"', size: 100 },
        { partNumber: 2, etag: '"b"', size: 50 },
      ]);
      ctx.storageService.completeMultipartUpload.mockResolvedValue(undefined);
      return ctx;
    }

    it('should complete the multipart upload, commit processing and enqueue', async () => {
      const { service, storageService, videoRepository, producer } =
        await setup();

      const video = await service.completeUpload(USER_ID, PUBLIC_ID);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/source',
        'upload-1',
        expect.arrayContaining([expect.objectContaining({ partNumber: 1 })]),
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING, upload_id: null },
      );
      expect(producer.enqueue).toHaveBeenCalledWith('video-1');
      expect(video.status).toBe(VideoStatus.PROCESSING);
    });

    it('should hide videos of other channels behind VIDEO_NOT_FOUND', async () => {
      const { service } = await setup(
        draftVideo({
          channel: { user_id: 'someone-else' } as Video['channel'],
        }),
      );

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should raise VIDEO_NOT_FOUND for an unknown id', async () => {
      const { service } = await setup(null);

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should reject videos that are no longer drafts', async () => {
      const { service } = await setup(
        draftVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotDraftException);
    });

    it('should raise UPLOAD_INCOMPLETE when a part is missing and keep the draft', async () => {
      const { service, storageService, videoRepository } = await setup();
      storageService.listUploadedParts.mockResolvedValue([
        { partNumber: 2, etag: '"b"', size: 50 },
      ]);

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should raise UPLOAD_INCOMPLETE when parts do not add up to the declared size', async () => {
      const { service, storageService } = await setup();
      storageService.listUploadedParts.mockResolvedValue([
        { partNumber: 1, etag: '"a"', size: 100 },
      ]);

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
    });

    it('should fail the video and delete the object on a size mismatch', async () => {
      const { service, storageService, videoRepository, producer } =
        await setup();
      storageService.headObject.mockReset();
      storageService.headObject
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ size: 999 });

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(storageService.deleteObject).toHaveBeenCalledWith(
        'videos/video-1/source',
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        expect.objectContaining({ status: VideoStatus.FAILED }),
      );
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should reuse an already assembled object on retry', async () => {
      const { service, storageService, producer } = await setup(
        draftVideo({ upload_id: null }),
      );
      storageService.headObject.mockReset();
      storageService.headObject.mockResolvedValue({ size: 150 });

      await service.completeUpload(USER_ID, PUBLIC_ID);

      expect(storageService.listUploadedParts).not.toHaveBeenCalled();
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(producer.enqueue).toHaveBeenCalledWith('video-1');
    });

    it('should revert to draft when enqueueing fails (compensation)', async () => {
      const { service, videoRepository, producer } = await setup();
      producer.enqueue.mockRejectedValue(new Error('redis down'));

      await expect(service.completeUpload(USER_ID, PUBLIC_ID)).rejects.toThrow(
        'redis down',
      );
      expect(videoRepository.update).toHaveBeenLastCalledWith(
        { id: 'video-1', status: VideoStatus.PROCESSING },
        { status: VideoStatus.DRAFT },
      );
    });

    it('should raise VIDEO_NOT_DRAFT when a concurrent completion won the race', async () => {
      const { service, videoRepository, producer } = await setup();
      videoRepository.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotDraftException);
      expect(producer.enqueue).not.toHaveBeenCalled();
    });
  });
  describe('findForReader', () => {
    function video(status: VideoStatus): Video {
      return {
        id: 'video-1',
        public_id: 'abcdefghijk',
        status,
        channel: { user_id: USER_ID },
      } as Video;
    }

    it('should let anyone read a ready video', async () => {
      const { service, videoRepository } = await buildVideosService();
      videoRepository.findOne.mockResolvedValue(video(VideoStatus.READY));

      const result = await service.findForReader('abcdefghijk');

      expect(result.isOwner).toBe(false);
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'should hide a %s video from non-owners',
      async (status) => {
        const { service, videoRepository } = await buildVideosService();
        videoRepository.findOne.mockResolvedValue(video(status));

        await expect(
          service.findForReader('abcdefghijk', 'someone-else'),
        ).rejects.toBeInstanceOf(VideoNotFoundException);
      },
    );

    it('should let the owner read a non-ready video', async () => {
      const { service, videoRepository } = await buildVideosService();
      videoRepository.findOne.mockResolvedValue(video(VideoStatus.FAILED));

      const result = await service.findForReader('abcdefghijk', USER_ID);

      expect(result.isOwner).toBe(true);
    });

    it('should raise VIDEO_NOT_FOUND for an unknown id', async () => {
      const { service, videoRepository } = await buildVideosService();
      videoRepository.findOne.mockResolvedValue(null);

      await expect(service.findForReader('nope')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });
  });

  describe('getPlaybackUrl', () => {
    const READY = {
      id: 'video-1',
      public_id: 'abcdefghijk',
      status: VideoStatus.READY,
      storage_key: 'videos/video-1/source',
      thumbnail_key: 'thumbnails/video-1.jpg',
      mime_type: 'video/mp4',
      original_filename: 'Trip.mp4',
      channel: { user_id: USER_ID },
    } as Video;

    it('should presign the source inline for streaming', async () => {
      const { service, videoRepository, storageService } =
        await buildVideosService();
      videoRepository.findOne.mockResolvedValue(READY);
      storageService.presignGetObject.mockResolvedValue('https://signed');

      await expect(
        service.getPlaybackUrl('abcdefghijk', 'stream'),
      ).resolves.toBe('https://signed');
      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/source',
        { contentType: 'video/mp4' },
      );
    });

    it('should presign the source as an attachment for downloads', async () => {
      const { service, videoRepository, storageService } =
        await buildVideosService();
      videoRepository.findOne.mockResolvedValue(READY);

      await service.getPlaybackUrl('abcdefghijk', 'download');

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/source',
        expect.objectContaining({
          contentDisposition: expect.stringContaining(
            'attachment; filename="Trip.mp4"',
          ),
        }),
      );
    });

    it('should presign the thumbnail key for thumbnails', async () => {
      const { service, videoRepository, storageService } =
        await buildVideosService();
      videoRepository.findOne.mockResolvedValue(READY);

      await service.getPlaybackUrl('abcdefghijk', 'thumbnail');

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'thumbnails/video-1.jpg',
        { contentType: 'image/jpeg' },
      );
    });

    it('should tell the owner a non-ready video is not ready yet', async () => {
      const { service, videoRepository } = await buildVideosService();
      videoRepository.findOne.mockResolvedValue({
        ...READY,
        status: VideoStatus.PROCESSING,
      });

      await expect(
        service.getPlaybackUrl('abcdefghijk', 'stream', USER_ID),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
    });
  });
});

describe('attachmentDisposition', () => {
  it('should keep plain ASCII names', () => {
    expect(attachmentDisposition('clip.mp4')).toBe(
      `attachment; filename="clip.mp4"; filename*=UTF-8''clip.mp4`,
    );
  });

  it('should escape quotes and non-ASCII characters', () => {
    expect(attachmentDisposition('Viagem à "Rio" (1).mp4')).toBe(
      `attachment; filename="Viagem _ _Rio_ (1).mp4"; filename*=UTF-8''Viagem%20%C3%A0%20%22Rio%22%20%281%29.mp4`,
    );
  });
});
