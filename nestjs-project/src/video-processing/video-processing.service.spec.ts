import { Test } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideosService } from '../videos/videos.service';
import { InvalidMediaError, MediaProbeService } from './media-probe.service';
import {
  NO_VIDEO_STREAM_ERROR,
  thumbnailTimestamp,
  VideoProcessingService,
} from './video-processing.service';

const VIDEO = {
  id: 'video-1',
  status: VideoStatus.PROCESSING,
  storage_key: 'videos/video-1/source',
} as Video;

const PROBE = {
  durationSeconds: 120,
  metadata: {
    width: 1280,
    height: 720,
    videoCodec: 'h264',
    audioCodec: 'aac',
    formatName: 'mp4',
    bitRate: 1000,
    frameRate: 30,
  },
};

async function setup() {
  const videosService = {
    findById: jest.fn().mockResolvedValue(VIDEO),
    markReady: jest.fn().mockResolvedValue(true),
    markFailed: jest.fn().mockResolvedValue(true),
  };
  const storageService = {
    presignGetObject: jest.fn().mockResolvedValue('http://minio/signed'),
    putObject: jest.fn().mockResolvedValue(undefined),
  };
  const mediaProbe = {
    probe: jest.fn().mockResolvedValue(PROBE),
    extractThumbnail: jest.fn().mockResolvedValue(Buffer.from([0xff, 0xd8])),
  };
  const module = await Test.createTestingModule({
    providers: [
      VideoProcessingService,
      { provide: VideosService, useValue: videosService },
      { provide: StorageService, useValue: storageService },
      { provide: MediaProbeService, useValue: mediaProbe },
    ],
  }).compile();
  return {
    service: module.get(VideoProcessingService),
    videosService,
    storageService,
    mediaProbe,
  };
}

describe('thumbnailTimestamp', () => {
  it('should pick 10% of the duration', () => {
    expect(thumbnailTimestamp(120)).toBe(12);
  });

  it('should use the first frame when the duration is unknown or zero', () => {
    expect(thumbnailTimestamp(null)).toBe(0);
    expect(thumbnailTimestamp(0)).toBe(0);
  });
});

describe('VideoProcessingService', () => {
  describe('processVideo', () => {
    it('should probe via an internal URL, store the thumbnail and mark ready', async () => {
      const { service, videosService, storageService, mediaProbe } =
        await setup();

      await service.processVideo('video-1');

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/source',
        { audience: 'internal' },
      );
      expect(mediaProbe.extractThumbnail).toHaveBeenCalledWith(
        'http://minio/signed',
        12,
      );
      expect(storageService.putObject).toHaveBeenCalledWith(
        'thumbnails/video-1.jpg',
        expect.any(Buffer),
        'image/jpeg',
      );
      expect(videosService.markReady).toHaveBeenCalledWith('video-1', {
        durationSeconds: 120,
        metadata: PROBE.metadata,
        thumbnailKey: 'thumbnails/video-1.jpg',
      });
    });

    it('should skip videos that are not processing (duplicate delivery)', async () => {
      const { service, videosService, mediaProbe } = await setup();
      videosService.findById.mockResolvedValue({
        ...VIDEO,
        status: VideoStatus.READY,
      });

      await service.processVideo('video-1');

      expect(mediaProbe.probe).not.toHaveBeenCalled();
      expect(videosService.markReady).not.toHaveBeenCalled();
    });

    it('should skip unknown videos', async () => {
      const { service, videosService, mediaProbe } = await setup();
      videosService.findById.mockResolvedValue(null);

      await service.processVideo('missing');

      expect(mediaProbe.probe).not.toHaveBeenCalled();
    });

    it('should throw UnrecoverableError when there is no video stream', async () => {
      const { service, mediaProbe } = await setup();
      mediaProbe.probe.mockResolvedValue(null);

      const error = await service.processVideo('video-1').catch((e) => e);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect((error as Error).message).toBe(NO_VIDEO_STREAM_ERROR);
    });

    it('should turn undecodable media into an UnrecoverableError', async () => {
      const { service, mediaProbe } = await setup();
      mediaProbe.probe.mockRejectedValue(
        new InvalidMediaError('ffprobe: Invalid data found'),
      );

      await expect(service.processVideo('video-1')).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
    });

    it('should let transient errors propagate as retryable', async () => {
      const { service, mediaProbe } = await setup();
      mediaProbe.probe.mockRejectedValue(new Error('Server returned 503'));

      const error = await service.processVideo('video-1').catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(UnrecoverableError);
    });
  });

  describe('handleFailure', () => {
    it('should mark the video failed on the final attempt', async () => {
      const { service, videosService } = await setup();

      await service.handleFailure('video-1', new Error('boom'), 3, 3);

      expect(videosService.markFailed).toHaveBeenCalledWith('video-1', 'boom');
    });

    it('should mark the video failed immediately on an unrecoverable error', async () => {
      const { service, videosService } = await setup();

      await service.handleFailure(
        'video-1',
        new UnrecoverableError(NO_VIDEO_STREAM_ERROR),
        1,
        3,
      );

      expect(videosService.markFailed).toHaveBeenCalledWith(
        'video-1',
        NO_VIDEO_STREAM_ERROR,
      );
    });

    it('should leave the video processing on an intermediate attempt', async () => {
      const { service, videosService } = await setup();

      await service.handleFailure('video-1', new Error('timeout'), 1, 3);

      expect(videosService.markFailed).not.toHaveBeenCalled();
    });
  });
});
