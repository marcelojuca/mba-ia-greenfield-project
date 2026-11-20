import { Test } from '@nestjs/testing';
import { Job } from 'bullmq';
import type { VideoProcessingJobData } from '../videos/videos.constants';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

function job(attemptsMade: number): Job<VideoProcessingJobData> {
  return {
    data: { videoId: 'video-1' },
    attemptsMade,
    opts: { attempts: 3 },
  } as Job<VideoProcessingJobData>;
}

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let processingService: {
    processVideo: jest.Mock;
    handleFailure: jest.Mock;
  };

  beforeEach(async () => {
    processingService = {
      processVideo: jest.fn().mockResolvedValue(undefined),
      handleFailure: jest.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: VideoProcessingService, useValue: processingService },
      ],
    }).compile();
    processor = module.get(VideoProcessingProcessor);
  });

  it('should delegate each job to the processing service', async () => {
    await processor.process(job(0));

    expect(processingService.processVideo).toHaveBeenCalledWith('video-1');
  });

  it('should report failures with the attempt counters', async () => {
    const error = new Error('boom');

    await processor.onFailed(job(3), error);

    expect(processingService.handleFailure).toHaveBeenCalledWith(
      'video-1',
      error,
      3,
      3,
    );
  });

  it('should never throw from the failed event handler', async () => {
    processingService.handleFailure.mockRejectedValue(new Error('db down'));

    await expect(
      processor.onFailed(job(3), new Error('boom')),
    ).resolves.toBeUndefined();
  });

  it('should ignore failed events without a job', async () => {
    await processor.onFailed(undefined, new Error('boom'));

    expect(processingService.handleFailure).not.toHaveBeenCalled();
  });
});
