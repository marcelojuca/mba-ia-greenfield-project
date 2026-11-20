import { randomBytes, randomUUID } from 'node:crypto';
import {
  DeleteBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { presignedRequest } from '../test/presigned-request';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIB = 1024 * 1024;

describe('StorageService (integration — MinIO)', () => {
  let module: TestingModule;
  let storage: StorageService;
  let config: ConfigType<typeof storageConfig>;
  const createdKeys: string[] = [];

  const key = (suffix: string): string => {
    const k = `test/${randomUUID()}/${suffix}`;
    createdKeys.push(k);
    return k;
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await module.init();
    storage = module.get(StorageService);
    config = module.get(storageConfig.KEY);
  });

  afterAll(async () => {
    for (const k of createdKeys) await storage.deleteObject(k);
    await module.close();
  });

  describe('ensureBucket', () => {
    it('creates a missing bucket and is idempotent on a second call', async () => {
      // Arrange — a dedicated, non-existent bucket
      const bucket = `test-bucket-${randomBytes(4).toString('hex')}`;
      const isolated = new StorageService({ ...config, bucket });

      // Act
      await isolated.ensureBucket();
      await isolated.ensureBucket();

      // Assert — the bucket exists and is empty
      const raw = new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: true,
        credentials: {
          accessKeyId: config.accessKey,
          secretAccessKey: config.secretKey,
        },
      });
      const listing = await raw.send(
        new ListObjectsV2Command({ Bucket: bucket }),
      );
      expect(listing.KeyCount).toBe(0);
      await raw.send(new DeleteBucketCommand({ Bucket: bucket }));
      raw.destroy();
      isolated.onModuleDestroy();
    });
  });

  describe('multipart upload through presigned part URLs', () => {
    it('assembles parts uploaded directly to storage into one object', async () => {
      // Arrange — 5 MiB minimum for every part except the last
      const objectKey = key('source');
      const part1 = randomBytes(5 * MIB);
      const part2 = randomBytes(1024);
      const uploadId = await storage.createMultipartUpload(
        objectKey,
        'video/mp4',
      );

      // Act — the "client" PUTs each part to its presigned URL
      for (const [index, bytes] of [part1, part2].entries()) {
        const url = await storage.presignUploadPart(
          objectKey,
          uploadId,
          index + 1,
        );
        const res = await presignedRequest(url, { method: 'PUT', body: bytes });
        expect(res.status).toBe(200);
      }
      const parts = await storage.listUploadedParts(objectKey, uploadId);
      await storage.completeMultipartUpload(objectKey, uploadId, parts);

      // Assert
      expect(parts.map((p) => p.partNumber)).toEqual([1, 2]);
      expect(parts.map((p) => p.size)).toEqual([part1.length, part2.length]);
      const head = await storage.headObject(objectKey);
      expect(head).toEqual({ size: part1.length + part2.length });
      const download = await presignedRequest(
        await storage.presignGetObject(objectKey),
      );
      expect(download.body.equals(Buffer.concat([part1, part2]))).toBe(true);
    });

    it('signs part URLs for the public endpoint', async () => {
      const objectKey = key('public-url');
      const uploadId = await storage.createMultipartUpload(
        objectKey,
        'video/mp4',
      );

      const url = new URL(
        await storage.presignUploadPart(objectKey, uploadId, 1),
      );

      expect(url.origin).toBe(new URL(config.publicEndpoint).origin);
      expect(url.searchParams.get('partNumber')).toBe('1');
      await storage.abortMultipartUpload(objectKey, uploadId);
    });

    it('lists only the parts that were actually uploaded', async () => {
      const objectKey = key('partial');
      const uploadId = await storage.createMultipartUpload(
        objectKey,
        'video/mp4',
      );
      const url = await storage.presignUploadPart(objectKey, uploadId, 2);
      await presignedRequest(url, { method: 'PUT', body: randomBytes(10) });

      const parts = await storage.listUploadedParts(objectKey, uploadId);

      expect(parts.map((p) => p.partNumber)).toEqual([2]);
      await storage.abortMultipartUpload(objectKey, uploadId);
    });
  });

  describe('objects and presigned GET', () => {
    it('serves byte ranges with 206 Partial Content', async () => {
      const objectKey = key('range');
      const bytes = randomBytes(4096);
      await storage.putObject(objectKey, bytes, 'video/mp4');

      const res = await presignedRequest(
        await storage.presignGetObject(objectKey),
        { headers: { range: 'bytes=0-9' } },
      );

      expect(res.status).toBe(206);
      expect(res.body.length).toBe(10);
      expect(res.body.equals(bytes.subarray(0, 10))).toBe(true);
      expect(res.headers['content-range']).toBe('bytes 0-9/4096');
    });

    it('applies an attachment Content-Disposition for downloads', async () => {
      const objectKey = key('download');
      await storage.putObject(objectKey, randomBytes(16), 'video/mp4');

      const res = await presignedRequest(
        await storage.presignGetObject(objectKey, {
          contentDisposition: 'attachment; filename="clip.mp4"',
        }),
      );

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="clip.mp4"',
      );
    });

    it('signs internal URLs for the Compose endpoint', async () => {
      const objectKey = key('internal');
      await storage.putObject(objectKey, randomBytes(16), 'video/mp4');

      const url = await storage.presignGetObject(objectKey, {
        audience: 'internal',
      });
      const res = await fetch(url);

      expect(new URL(url).origin).toBe(new URL(config.endpoint).origin);
      expect(res.status).toBe(200);
    });

    it('returns null from headObject for a missing key', async () => {
      await expect(storage.headObject(`test/${randomUUID()}`)).resolves.toBe(
        null,
      );
    });

    it('deletes objects', async () => {
      const objectKey = key('delete-me');
      await storage.putObject(objectKey, randomBytes(8), 'image/jpeg');

      await storage.deleteObject(objectKey);

      await expect(storage.headObject(objectKey)).resolves.toBeNull();
    });
  });
});
