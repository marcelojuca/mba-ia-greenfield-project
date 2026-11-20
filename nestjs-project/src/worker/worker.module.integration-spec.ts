import { INestApplicationContext } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { VideoProcessingProcessor } from '../video-processing/video-processing.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule (integration)', () => {
  let app: INestApplicationContext;

  beforeAll(async () => {
    // Same bootstrap as src/worker.ts — real PostgreSQL, Redis and MinIO.
    app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  it('connects to the database with the full entity graph', () => {
    const dataSource = app.get(DataSource);

    expect(dataSource.isInitialized).toBe(true);
    expect(dataSource.hasMetadata('videos')).toBe(true);
    expect(dataSource.hasMetadata('channels')).toBe(true);
    expect(dataSource.hasMetadata('users')).toBe(true);
  });

  it('registers a running worker on the video-processing queue', async () => {
    const processor = app.get(VideoProcessingProcessor);

    expect(processor.worker.name).toBe('video-processing');
    await processor.worker.waitUntilReady();
    expect(processor.worker.isRunning()).toBe(true);
  });

  it('starts no HTTP server', () => {
    // An application context has no HTTP adapter (null), unlike NestFactory.create().
    expect(app.get(HttpAdapterHost, { strict: false }).httpAdapter).toBeNull();
  });
});
