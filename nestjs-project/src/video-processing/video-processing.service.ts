import { Injectable, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/entities/video.entity';
import {
  THUMBNAIL_CONTENT_TYPE,
  VIDEO_STORAGE_KEYS,
} from '../videos/videos.constants';
import { VideosService } from '../videos/videos.service';
import { InvalidMediaError, MediaProbeService } from './media-probe.service';

export const NO_VIDEO_STREAM_ERROR = 'Source has no video stream';

/** Thumbnail frame position: 10% into the video, start when unknown (TD-05). */
export function thumbnailTimestamp(durationSeconds: number | null): number {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  return durationSeconds * 0.1;
}

/**
 * Business logic of the video worker (phase-03-videos/TD-05, TD-08):
 * probe → thumbnail → store → `ready`; undecodable media fails without retries.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly mediaProbe: MediaProbeService,
  ) {}

  async processVideo(videoId: string): Promise<void> {
    const video = await this.videosService.findById(videoId);
    if (!video || video.status !== VideoStatus.PROCESSING) {
      // At-least-once delivery: duplicates and stale jobs are no-ops.
      this.logger.warn(
        `Skipping job for video ${videoId}: ${video ? `status is ${video.status}` : 'not found'}`,
      );
      return;
    }

    const sourceUrl = await this.storageService.presignGetObject(
      video.storage_key,
      { audience: 'internal' },
    );

    const probe = await this.permanentOnInvalidMedia(() =>
      this.mediaProbe.probe(sourceUrl),
    );
    if (!probe) throw new UnrecoverableError(NO_VIDEO_STREAM_ERROR);

    const thumbnail = await this.permanentOnInvalidMedia(() =>
      this.mediaProbe.extractThumbnail(
        sourceUrl,
        thumbnailTimestamp(probe.durationSeconds),
      ),
    );
    const thumbnailKey = VIDEO_STORAGE_KEYS.thumbnail(video.id);
    await this.storageService.putObject(
      thumbnailKey,
      thumbnail,
      THUMBNAIL_CONTENT_TYPE,
    );

    await this.videosService.markReady(video.id, {
      durationSeconds: probe.durationSeconds,
      metadata: probe.metadata,
      thumbnailKey,
    });
    this.logger.log(`Video ${video.id} is ready`);
  }

  /**
   * Decides what a failed attempt means for the video: only the final attempt
   * (or an unrecoverable error) marks it `failed`; earlier attempts are retried.
   */
  async handleFailure(
    videoId: string,
    error: Error,
    attemptsMade: number,
    maxAttempts: number,
  ): Promise<void> {
    const final =
      error instanceof UnrecoverableError || attemptsMade >= maxAttempts;
    if (!final) {
      this.logger.warn(
        `Video ${videoId} attempt ${attemptsMade}/${maxAttempts} failed, will retry: ${error.message}`,
      );
      return;
    }
    await this.videosService.markFailed(videoId, error.message);
    this.logger.error(`Video ${videoId} failed: ${error.message}`);
  }

  private async permanentOnInvalidMedia<T>(step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (err) {
      if (err instanceof InvalidMediaError) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }
}
