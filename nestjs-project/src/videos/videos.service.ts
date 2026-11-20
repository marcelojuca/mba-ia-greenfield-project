import { randomUUID } from 'node:crypto';
import { S3ServiceException } from '@aws-sdk/client-s3';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isUniqueViolationOn } from '../common/database/pg-errors';
import storageConfig from '../config/storage.config';
import { StorageService, type UploadedPart } from '../storage/storage.service';
import {
  Video,
  type VideoMetadata,
  VideoStatus,
} from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { planUploadParts } from './upload-part-plan.util';
import { VideoProcessingProducer } from './video-processing.producer';
import {
  ChannelNotFoundException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotDraftException,
  VideoNotFoundException,
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

export interface ProcessingResult {
  durationSeconds: number | null;
  metadata: VideoMetadata;
  thumbnailKey: string;
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
    private readonly processingProducer: VideoProcessingProducer,
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

  /**
   * Finalizes the direct upload and hands the video to the worker
   * (phase-03-videos/TD-02, TD-08): verify parts → complete multipart →
   * verify size → commit `processing` → enqueue (compensate on failure).
   */
  async completeUpload(userId: string, publicId: string): Promise<Video> {
    const video = await this.findOwnedOrFail(publicId, userId);
    if (video.status !== VideoStatus.DRAFT) throw new VideoNotDraftException();

    await this.finalizeStoredObject(video);

    const committed = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      { status: VideoStatus.PROCESSING, upload_id: null },
    );
    if (!committed.affected) throw new VideoNotDraftException();

    try {
      await this.processingProducer.enqueue(video.id);
    } catch (err) {
      // Compensation: the job never reached the queue — back to draft so the
      // client can retry completion (the stored object is reused).
      await this.videoRepository.update(
        { id: video.id, status: VideoStatus.PROCESSING },
        { status: VideoStatus.DRAFT },
      );
      throw err;
    }

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    return video;
  }

  async findById(id: string): Promise<Video | null> {
    return this.videoRepository.findOneBy({ id });
  }

  /**
   * Worker success transition `processing → ready` (phase-03-videos/TD-08).
   * Conditional on `processing` so redelivered jobs cannot regress a video.
   */
  async markReady(id: string, result: ProcessingResult): Promise<boolean> {
    const { affected } = await this.videoRepository.update(
      { id, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_seconds: result.durationSeconds,
        metadata: result.metadata,
        thumbnail_key: result.thumbnailKey,
        processing_error: null,
        processed_at: new Date(),
      },
    );
    return Boolean(affected);
  }

  /** Worker failure transition `processing → failed` (phase-03-videos/TD-08). */
  async markFailed(id: string, reason: string): Promise<boolean> {
    const { affected } = await this.videoRepository.update(
      { id, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, processing_error: reason.slice(0, 2000) },
    );
    return Boolean(affected);
  }

  /** Loads a video with its channel; non-owners get VIDEO_NOT_FOUND (no leak). */
  private async findOwnedOrFail(
    publicId: string,
    userId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: { channel: true },
    });
    if (!video || video.channel.user_id !== userId) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /**
   * Makes sure the source object exists with exactly the declared size.
   * Idempotent: when a previous completion already assembled the object
   * (e.g. enqueue failed and was compensated) it is reused as-is.
   */
  private async finalizeStoredObject(video: Video): Promise<void> {
    let stored = await this.storageService.headObject(video.storage_key);

    if (!stored) {
      if (!video.upload_id) throw new UploadIncompleteException();
      const parts = await this.storageService.listUploadedParts(
        video.storage_key,
        video.upload_id,
      );
      if (!this.coversDeclaredSize(parts, video.size_bytes)) {
        throw new UploadIncompleteException();
      }
      await this.completeMultipart(video, parts);
      stored = await this.storageService.headObject(video.storage_key);
    }

    if (stored?.size !== video.size_bytes) {
      await this.storageService.deleteObject(video.storage_key);
      await this.videoRepository.update(
        { id: video.id },
        {
          status: VideoStatus.FAILED,
          upload_id: null,
          processing_error: `Uploaded size (${stored?.size ?? 0} bytes) does not match the declared size (${video.size_bytes} bytes)`,
        },
      );
      throw new UploadSizeMismatchException();
    }
  }

  /** Parts must be numbered 1..N without gaps and add up to the declared size. */
  private coversDeclaredSize(
    parts: UploadedPart[],
    sizeBytes: number,
  ): boolean {
    if (parts.length === 0) return false;
    const contiguous = parts.every((p, i) => p.partNumber === i + 1);
    const total = parts.reduce((sum, p) => sum + p.size, 0);
    return contiguous && total >= sizeBytes;
  }

  private async completeMultipart(
    video: Video,
    parts: UploadedPart[],
  ): Promise<void> {
    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id!,
        parts,
      );
    } catch (err) {
      // Malformed part set (e.g. a non-final part under 5 MiB): the upload is
      // still open, so the client can re-send parts and retry.
      if (
        err instanceof S3ServiceException &&
        ['EntityTooSmall', 'InvalidPart', 'InvalidPartOrder'].includes(err.name)
      ) {
        throw new UploadIncompleteException();
      }
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
