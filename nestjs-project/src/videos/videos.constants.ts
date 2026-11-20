import type { JobsOptions } from 'bullmq';

/** Queue consumed by the video worker (### Events/Messages → video.process). */
export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';

/** Delivery policy of phase-03-videos/TD-08. */
export const VIDEO_PROCESSING_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 1000,
} as const satisfies JobsOptions;

/** Regenerations allowed when a new public_id collides (phase-03-videos/TD-06). */
export const PUBLIC_ID_MAX_RETRIES = 5;

/** S3 multipart hard limit on the number of parts. */
export const MAX_UPLOAD_PARTS = 10_000;

export const VIDEO_TITLE_MAX_LENGTH = 100;

/** Storage keys derived from the immutable video id (phase-03-videos/TD-03). */
export const VIDEO_STORAGE_KEYS = {
  source: (videoId: string): string => `videos/${videoId}/source`,
  thumbnail: (videoId: string): string => `thumbnails/${videoId}.jpg`,
} as const;

export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

export interface VideoProcessingJobData {
  videoId: string;
}
