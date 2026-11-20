import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue keys (phase 03)', () => {
  it('should apply defaults that point to the Compose services', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'streamtube',
      UPLOAD_MAX_SIZE_BYTES: 10 * 1024 ** 3,
      UPLOAD_PART_SIZE_BYTES: 100 * 1024 ** 2,
      UPLOAD_URL_EXPIRES_SECONDS: 86400,
      DOWNLOAD_URL_EXPIRES_SECONDS: 3600,
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      QUEUE_PREFIX: 'streamtube',
    });
  });

  it('should reject a part size below the S3 minimum of 5 MiB', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '1000' });
    expect(error?.message).toContain('UPLOAD_PART_SIZE_BYTES');
  });

  it('should reject an S3 endpoint that is not an http(s) URI', () => {
    const { error } = validate({ S3_ENDPOINT: 'not-a-url' });
    expect(error?.message).toContain('S3_ENDPOINT');
  });

  it('should reject presigned URL TTLs above the 7-day SigV4 limit', () => {
    const { error } = validate({ UPLOAD_URL_EXPIRES_SECONDS: '604801' });
    expect(error?.message).toContain('UPLOAD_URL_EXPIRES_SECONDS');
  });

  it('should reject an invalid Redis port', () => {
    const { error } = validate({ REDIS_PORT: '70000' });
    expect(error?.message).toContain('REDIS_PORT');
  });
});
