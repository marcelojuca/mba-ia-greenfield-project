import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
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
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { UploadSessionDto } from './dto/upload-session.dto';
import { VideoPresenter } from './video.presenter';
import { VideosService } from './videos.service';

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
}
