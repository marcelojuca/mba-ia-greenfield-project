import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),

  // Object storage (S3-compatible — MinIO locally) — phase-03-videos/TD-09
  S3_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://minio:9000'),
  S3_PUBLIC_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:9000'),
  S3_REGION: Joi.string().default('us-east-1'),
  S3_ACCESS_KEY: Joi.string().default('streamtube'),
  S3_SECRET_KEY: Joi.string().default('streamtube-secret'),
  S3_BUCKET: Joi.string()
    .pattern(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .default('streamtube'),
  UPLOAD_MAX_SIZE_BYTES: Joi.number()
    .integer()
    .min(1)
    .max(5 * 1024 ** 4) // S3 object limit: 5 TiB
    .default(10 * 1024 ** 3),
  UPLOAD_PART_SIZE_BYTES: Joi.number()
    .integer()
    .min(5 * 1024 ** 2) // S3 multipart minimum part size: 5 MiB
    .max(5 * 1024 ** 3) // S3 multipart maximum part size: 5 GiB
    .default(100 * 1024 ** 2),
  UPLOAD_URL_EXPIRES_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(604800) // SigV4 presigned URL maximum: 7 days
    .default(86400),
  DOWNLOAD_URL_EXPIRES_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(604800)
    .default(3600),

  // Queue (BullMQ on Redis) — phase-03-videos/TD-09
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().port().default(6379),
  QUEUE_PREFIX: Joi.string()
    .pattern(/^[A-Za-z0-9_-]+$/)
    .default('streamtube'),
});
