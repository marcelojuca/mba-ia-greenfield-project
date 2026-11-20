import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isUniqueViolationOn } from '../common/database/pg-errors';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { planUploadParts } from './upload-part-plan.util';
import {
  ChannelNotFoundException,
  VideoTooLargeException,
} from './videos.exceptions';
import {
  PUBLIC_ID_MAX_RETRIES,
  VIDEO_STORAGE_KEYS,
  VIDEO_TITLE_MAX_LENGTH,
} from './videos.constants';

export interface InitiateUploadInput {
  fileName: string;
  fileSize: number;
  contentType: string;
  title?: string;
}

export interface UploadSession {
  video: Video;
  partSize: number;
  partCount: number;
  expiresAt: Date;
  parts: { partNumber: number; url: string }[];
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Pre-registers a draft video in the caller's channel and opens a multipart
   * upload whose parts the client sends straight to object storage
   * (phase-03-videos/TD-02, TD-08).
   */
  async initiateUpload(
    userId: string,
    input: InitiateUploadInput,
  ): Promise<UploadSession> {
    if (input.fileSize > this.storageCfg.uploadMaxSizeBytes) {
      throw new VideoTooLargeException(this.storageCfg.uploadMaxSizeBytes);
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();

    const { partSize, partCount } = planUploadParts(
      input.fileSize,
      this.storageCfg.uploadPartSizeBytes,
    );
    const video = await this.insertDraft(channel.id, input);

    try {
      const uploadId = await this.storageService.createMultipartUpload(
        video.storage_key,
        video.mime_type,
      );
      video.upload_id = uploadId;
      await this.videoRepository.update(
        { id: video.id },
        { upload_id: uploadId },
      );

      const parts = await Promise.all(
        Array.from({ length: partCount }, async (_, index) => ({
          partNumber: index + 1,
          url: await this.storageService.presignUploadPart(
            video.storage_key,
            uploadId,
            index + 1,
          ),
        })),
      );
      const expiresAt = new Date(
        Date.now() + this.storageCfg.uploadUrlExpiresSeconds * 1000,
      );

      return { video, partSize, partCount, expiresAt, parts };
    } catch (err) {
      // Compensation: no draft without a usable upload session.
      if (video.upload_id) {
        await this.storageService.abortMultipartUpload(
          video.storage_key,
          video.upload_id,
        );
      }
      await this.videoRepository.delete({ id: video.id });
      throw err;
    }
  }

  private async insertDraft(
    channelId: string,
    input: InitiateUploadInput,
  ): Promise<Video> {
    const id = randomUUID();
    const draft = this.videoRepository.create({
      id,
      channel_id: channelId,
      title: this.resolveTitle(input),
      status: VideoStatus.DRAFT,
      original_filename: input.fileName,
      mime_type: input.contentType,
      size_bytes: input.fileSize,
      storage_key: VIDEO_STORAGE_KEYS.source(id),
      upload_id: null,
    });

    for (let attempt = 0; ; attempt++) {
      draft.public_id = generatePublicId();
      try {
        await this.videoRepository.insert(draft);
        return draft;
      } catch (err) {
        if (
          !isUniqueViolationOn(err, 'public_id') ||
          attempt >= PUBLIC_ID_MAX_RETRIES
        ) {
          throw err;
        }
      }
    }
  }

  /** Explicit title, or the file name without its extension (validation AMB-2). */
  private resolveTitle(input: InitiateUploadInput): string {
    const explicit = input.title?.trim();
    const fromFileName = input.fileName.replace(/\.[^./\\]+$/, '').trim();
    const title = explicit || fromFileName || input.fileName.trim();
    return title.slice(0, VIDEO_TITLE_MAX_LENGTH);
  }
}
