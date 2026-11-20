import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY ?? 'streamtube',
  secretKey: process.env.S3_SECRET_KEY ?? 'streamtube-secret',
  bucket: process.env.S3_BUCKET ?? 'streamtube',
  uploadMaxSizeBytes: parseInt(
    process.env.UPLOAD_MAX_SIZE_BYTES ?? '10737418240',
    10,
  ),
  uploadPartSizeBytes: parseInt(
    process.env.UPLOAD_PART_SIZE_BYTES ?? '104857600',
    10,
  ),
  uploadUrlExpiresSeconds: parseInt(
    process.env.UPLOAD_URL_EXPIRES_SECONDS ?? '86400',
    10,
  ),
  downloadUrlExpiresSeconds: parseInt(
    process.env.DOWNLOAD_URL_EXPIRES_SECONDS ?? '3600',
    10,
  ),
}));
