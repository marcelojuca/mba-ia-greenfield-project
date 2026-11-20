import { MAX_UPLOAD_PARTS } from './videos.constants';

export interface UploadPartPlan {
  partSize: number;
  partCount: number;
}

/**
 * Splits a declared file size into S3 multipart parts (phase-03-videos/TD-02):
 * the configured part size, raised when needed so the upload never exceeds
 * the 10,000-part limit.
 */
export function planUploadParts(
  fileSize: number,
  configuredPartSize: number,
): UploadPartPlan {
  const partSize = Math.max(
    configuredPartSize,
    Math.ceil(fileSize / MAX_UPLOAD_PARTS),
  );
  return { partSize, partCount: Math.max(1, Math.ceil(fileSize / partSize)) };
}
