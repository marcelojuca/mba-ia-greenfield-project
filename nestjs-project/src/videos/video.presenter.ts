import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import appConfig from '../config/app.config';
import { UploadSessionDto } from './dto/upload-session.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import type { UploadSession } from './videos.service';

/** Maps video domain objects to the HTTP contract (### API Contracts). */
@Injectable()
export class VideoPresenter {
  constructor(
    @Inject(appConfig.KEY)
    private readonly app: ConfigType<typeof appConfig>,
  ) {}

  /** The unique URL of a video (phase-03-videos/TD-06). */
  videoUrl(publicId: string): string {
    return `${this.app.url.replace(/\/$/, '')}/videos/${publicId}`;
  }

  toUploadSession(session: UploadSession): UploadSessionDto {
    return {
      id: session.video.public_id,
      title: session.video.title,
      status: session.video.status,
      url: this.videoUrl(session.video.public_id),
      upload: {
        partSize: session.partSize,
        partCount: session.partCount,
        expiresAt: session.expiresAt.toISOString(),
        parts: session.parts,
      },
    };
  }

  /**
   * `video.channel` must be loaded. `isOwner` controls owner-only fields
   * (phase-03-videos/TD-07 revision).
   */
  toVideo(video: Video, isOwner: boolean): VideoResponseDto {
    const url = this.videoUrl(video.public_id);
    const ready = video.status === VideoStatus.READY;
    return {
      id: video.public_id,
      title: video.title,
      status: video.status,
      url,
      originalFilename: video.original_filename,
      mimeType: video.mime_type,
      sizeBytes: video.size_bytes,
      durationSeconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnailUrl: ready ? `${url}/thumbnail` : null,
      streamUrl: ready ? `${url}/stream` : null,
      downloadUrl: ready ? `${url}/download` : null,
      processingError: isOwner ? video.processing_error : null,
      channel: {
        nickname: video.channel.nickname,
        name: video.channel.name,
      },
      createdAt: video.created_at.toISOString(),
      processedAt: video.processed_at ? video.processed_at.toISOString() : null,
    };
  }
}
