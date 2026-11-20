import {
  applyDecorators,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OptionalUser } from '../auth/decorators/optional-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { UploadSessionDto } from './dto/upload-session.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoPresenter } from './video.presenter';
import { type PlaybackKind, VideosService } from './videos.service';

// Throttling stays scoped to auth endpoints (phase-02-auth/TD-08); players
// issue many range requests against the stream endpoint.
@SkipThrottle()
@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly presenter: VideoPresenter,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft in the caller channel and returns one presigned URL per part. ' +
      'The client uploads the file straight to object storage (S3 multipart) and then calls ' +
      'POST /videos/{id}/upload/complete — the file never passes through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created; upload instructions returned',
    type: UploadSessionDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or VIDEO_TOO_LARGE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'CHANNEL_NOT_FOUND — the user has no channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<UploadSessionDto> {
    const session = await this.videosService.initiateUpload(user.sub, dto);
    return this.presenter.toUploadSession(session);
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Assembles the parts uploaded to object storage, checks the stored size and queues the video ' +
      'for background processing (duration, metadata, thumbnail). Returns the video in `processing`.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed; processing queued',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'UPLOAD_INCOMPLETE — not every part was uploaded',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND — unknown video or owned by another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_DRAFT — upload already completed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description:
      'UPLOAD_SIZE_MISMATCH — stored size differs from the declared size (video marked failed)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.completeUpload(user.sub, id);
    return this.presenter.toVideo(video, true);
  }

  @Public()
  @Get(':id')
  @ApiOperation({
    summary: 'Get a video by its unique URL id',
    description:
      'Public for ready videos. The owner (optional bearer token) can also read drafts, ' +
      'videos in processing and failed videos, including the failure reason.',
  })
  @ApiResponse({ status: 200, type: VideoResponseDto })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND — unknown id, or not ready and caller is not the owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @Param('id') id: string,
    @OptionalUser() user?: JwtPayload,
  ): Promise<VideoResponseDto> {
    const { video, isOwner } = await this.videosService.findForReader(
      id,
      user?.sub,
    );
    return this.presenter.toVideo(video, isOwner);
  }

  @Public()
  @Get(':id/stream')
  @Redirect(undefined, HttpStatus.FOUND)
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a short-lived presigned storage URL. Use it as <video src>: storage answers ' +
      'Range requests with 206 Partial Content, so playback starts without a full download.',
  })
  @PlaybackResponses('Presigned streaming URL')
  async stream(
    @Param('id') id: string,
    @OptionalUser() user?: JwtPayload,
  ): Promise<{ url: string }> {
    return this.playback(id, 'stream', user);
  }

  @Public()
  @Get(':id/download')
  @Redirect(undefined, HttpStatus.FOUND)
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a short-lived presigned URL served with Content-Disposition: attachment ' +
      'and the original file name.',
  })
  @PlaybackResponses('Presigned download URL')
  async download(
    @Param('id') id: string,
    @OptionalUser() user?: JwtPayload,
  ): Promise<{ url: string }> {
    return this.playback(id, 'download', user);
  }

  @Public()
  @Get(':id/thumbnail')
  @Redirect(undefined, HttpStatus.FOUND)
  @ApiOperation({
    summary: 'Get the video thumbnail',
    description:
      'Redirects to a short-lived presigned URL of the JPEG generated from a frame of the video.',
  })
  @PlaybackResponses('Presigned thumbnail URL')
  async thumbnail(
    @Param('id') id: string,
    @OptionalUser() user?: JwtPayload,
  ): Promise<{ url: string }> {
    return this.playback(id, 'thumbnail', user);
  }

  private async playback(
    id: string,
    kind: PlaybackKind,
    user?: JwtPayload,
  ): Promise<{ url: string }> {
    return {
      url: await this.videosService.getPlaybackUrl(id, kind, user?.sub),
    };
  }
}

/** Shared OpenAPI responses of the redirecting playback endpoints. */
function PlaybackResponses(description: string): MethodDecorator {
  return applyDecorators(
    ApiResponse({
      status: 302,
      description,
      headers: { Location: { description, schema: { type: 'string' } } },
    }),
    ApiResponse({
      status: 404,
      description:
        'VIDEO_NOT_FOUND — unknown id, or not ready and caller is not the owner',
      schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
    }),
    ApiResponse({
      status: 409,
      description:
        'VIDEO_NOT_READY — owner requesting a video that is not ready',
      schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
    }),
  );
}
