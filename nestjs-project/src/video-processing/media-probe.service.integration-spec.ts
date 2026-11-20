import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  createAudioOnlyFixture,
  createCorruptFixture,
  createVideoFixture,
} from '../test/video-fixture';
import { InvalidMediaError, MediaProbeService } from './media-probe.service';

describe('MediaProbeService (integration — ffmpeg over presigned MinIO URLs)', () => {
  let module: TestingModule;
  let storage: StorageService;
  let probe: MediaProbeService;
  const keys: string[] = [];

  async function storeAndSign(bytes: Buffer, type = 'video/mp4') {
    const key = `test/${randomUUID()}/source`;
    keys.push(key);
    await storage.putObject(key, bytes, type);
    return storage.presignGetObject(key, { audience: 'internal' });
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [MediaProbeService],
    }).compile();
    await module.init();
    storage = module.get(StorageService);
    probe = module.get(MediaProbeService);
  });

  afterAll(async () => {
    for (const key of keys) await storage.deleteObject(key);
    await module.close();
  });

  it('extracts duration and metadata of an H.264 fixture', async () => {
    const url = await storeAndSign(await createVideoFixture());

    const result = await probe.probe(url);

    expect(result?.durationSeconds).toBeCloseTo(3, 1);
    expect(result?.metadata).toMatchObject({
      width: 320,
      height: 240,
      videoCodec: 'h264',
      audioCodec: 'aac',
      frameRate: 25,
    });
  });

  it('returns null for decodable media without a video stream', async () => {
    const url = await storeAndSign(await createAudioOnlyFixture(), 'audio/mp4');

    await expect(probe.probe(url)).resolves.toBeNull();
  });

  it('rejects with InvalidMediaError for a corrupt file', async () => {
    const url = await storeAndSign(createCorruptFixture());

    await expect(probe.probe(url)).rejects.toBeInstanceOf(InvalidMediaError);
  });

  it('renders a JPEG thumbnail at the requested time', async () => {
    const url = await storeAndSign(await createVideoFixture());

    const jpeg = await probe.extractThumbnail(url, 0.3);

    expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(jpeg.length).toBeGreaterThan(1000);
  });

  it('rejects with a retryable (non-media) error when storage refuses the URL', async () => {
    const error: unknown = await probe
      .probe('http://minio:9000/streamtube/does-not-exist')
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(InvalidMediaError);
  });
});
