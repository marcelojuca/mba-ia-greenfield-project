import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configModuleOptions } from '../config/config-module.options';
import { DatabaseModule } from '../database/database.module';
import { QueueModule } from '../queue/queue.module';
import { UsersModule } from '../users/users.module';
import { VideoProcessingModule } from '../video-processing/video-processing.module';

/**
 * Root module of the video worker process (phase-03-videos/TD-04): same config,
 * database and queue setup as the API, plus the queue processor — no HTTP.
 */
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    DatabaseModule,
    QueueModule,
    // Registers User: autoLoadEntities must see the whole relation graph
    // Video → Channel → User, or TypeORM refuses to build Channel#user.
    UsersModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
