import { randomUUID } from 'node:crypto';
import { TestingModule } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import {
  createChannelOwner,
  createVideoTestingModule,
} from '../test/video-test-module';
import {
  createAudioOnlyFixture,
  createCorruptFixture,
  createVideoFixture,
} from '../test/video-fixture';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';
import { VIDEO_STORAGE_KEYS } from '../videos/videos.constants';
import { VideosModule } from '../videos/videos.module';
import { MediaProbeService } from './media-probe.service';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService (integration — PostgreSQL + MinIO + ffmpeg)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let storage: StorageService;
  let service: VideoProcessingService;
  const keys: string[] = [];

  beforeAll(async () => {
    // The processing service without the queue processor: no worker is started.
    module = await createVideoTestingModule([
      VideosModule,
      StorageModule,
      {
        module: class ProcessingUnderTest {},
        imports: [VideosModule, StorageModule],
        providers: [MediaProbeService, VideoProcessingService],
        exports: [VideoProcessingService],
      },
    ]);
    dataSource = module.get(DataSource);
    videos = dataSource.getRepository(Video);
    storage = module.get(StorageService);
    service = module.get(VideoProcessingService);
  });

  afterAll(async () => {
    for (const key of keys) await storage.deleteObject(key);
    await cleanAllTables(dataSource);
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function processingVideoWith(source: Buffer): Promise<Video> {
    const { channelId } = await createChannelOwner(dataSource);
    const id = randomUUID();
    const storageKey = VIDEO_STORAGE_KEYS.source(id);
    keys.push(storageKey, VIDEO_STORAGE_KEYS.thumbnail(id));
    await storage.putObject(storageKey, source, 'video/mp4');
    await videos.insert({
      id,
      public_id: generatePublicId(),
      channel_id: channelId,
      title: 'fixture',
      status: VideoStatus.PROCESSING,
      original_filename: 'fixture.mp4',
      mime_type: 'video/mp4',
      size_bytes: source.length,
      storage_key: storageKey,
    });
    return videos.findOneByOrFail({ id });
  }

  it('turns a processing MP4 into a ready video with metadata and thumbnail', async () => {
    const video = await processingVideoWith(await createVideoFixture());

    await service.processVideo(video.id);

    const saved = await videos.findOneByOrFail({ id: video.id });
    expect(saved.status).toBe(VideoStatus.READY);
    expect(saved.duration_seconds).toBeCloseTo(3, 1);
    expect(saved.metadata).toMatchObject({ width: 320, height: 240 });
    expect(saved.thumbnail_key).toBe(`thumbnails/${video.id}.jpg`);
    expect(saved.processed_at).toBeInstanceOf(Date);
    await expect(storage.headObject(saved.thumbnail_key!)).resolves.toEqual({
      size: expect.any(Number),
    });
  });

  it('rejects with UnrecoverableError for audio-only media and leaves the status to the failure handler', async () => {
    const video = await processingVideoWith(await createAudioOnlyFixture());

    await expect(service.processVideo(video.id)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await service.handleFailure(
      video.id,
      new UnrecoverableError('Source has no video stream'),
      1,
      3,
    );

    const saved = await videos.findOneByOrFail({ id: video.id });
    expect(saved.status).toBe(VideoStatus.FAILED);
    expect(saved.processing_error).toBe('Source has no video stream');
  });

  it('rejects with UnrecoverableError for a corrupt upload', async () => {
    const video = await processingVideoWith(createCorruptFixture());

    await expect(service.processVideo(video.id)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('does not touch a video that is already ready', async () => {
    const video = await processingVideoWith(await createVideoFixture());
    await videos.update({ id: video.id }, { status: VideoStatus.READY });

    await service.processVideo(video.id);

    const saved = await videos.findOneByOrFail({ id: video.id });
    expect(saved.thumbnail_key).toBeNull();
  });
});
