import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';

/**
 * Root BullMQ registration (phase-03-videos/TD-01), shared by the API and the
 * video worker. The prefix namespaces all queue keys in Redis (TD-09) — tests
 * override it so they never compete with the running video-worker container.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: { host: cfg.host, port: cfg.port },
        prefix: cfg.prefix,
      }),
    }),
  ],
})
export class QueueModule {}
