import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './videos.constants';

/** Publishes `video.process` jobs (phase-03-videos/TD-01, TD-08). */
@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<VideoProcessingJobData>,
  ) {}

  /**
   * Enqueues processing for a video. `jobId = videoId` makes repeated calls
   * for the same video collapse into one job while its record exists.
   */
  async enqueue(videoId: string): Promise<void> {
    await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      { ...VIDEO_PROCESSING_JOB_OPTIONS, jobId: videoId },
    );
  }
}
