import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { VideosModule } from '../videos/videos.module';
import { MediaProbeService } from './media-probe.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

/**
 * Worker-side module (phase-03-videos/TD-04). Imported only by WorkerModule —
 * never by AppModule — so the API process does not consume jobs.
 */
@Module({
  imports: [
    VideosModule,
    StorageModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [
    MediaProbeService,
    VideoProcessingService,
    VideoProcessingProcessor,
  ],
})
export class VideoProcessingModule {}
