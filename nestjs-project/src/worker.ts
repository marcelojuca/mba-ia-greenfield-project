import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';
import { VIDEO_PROCESSING_QUEUE } from './videos/videos.constants';

/** Entrypoint of the `video-worker` container: consumes video-processing jobs. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM (docker compose stop) lets BullMQ finish/return the active job.
  app.enableShutdownHooks();
  new Logger('VideoWorker').log(
    `Video worker started — consuming queue "${VIDEO_PROCESSING_QUEUE}"`,
  );
}
void bootstrap();
