import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from '../videos/videos.constants';
import { VideoProcessingService } from './video-processing.service';

/** Consumer of `video.process` jobs — runs only in the video-worker process. */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(private readonly processingService: VideoProcessingService) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    await this.processingService.processVideo(job.data.videoId);
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessingJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    try {
      await this.processingService.handleFailure(
        job.data.videoId,
        error,
        job.attemptsMade,
        job.opts.attempts ?? 1,
      );
    } catch (err) {
      // Event handler: rethrowing would crash the worker — log instead.
      this.logger.error(
        `Could not record failure of video ${job.data.videoId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
