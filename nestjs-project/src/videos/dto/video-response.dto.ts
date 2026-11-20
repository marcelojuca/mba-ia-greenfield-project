import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class VideoMetadataDto {
  @ApiProperty({ example: 1920 })
  width: number;

  @ApiProperty({ example: 1080 })
  height: number;

  @ApiProperty({ example: 'h264' })
  videoCodec: string;

  @ApiProperty({ example: 'aac', nullable: true, type: String })
  audioCodec: string | null;

  @ApiProperty({ example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  formatName: string;

  @ApiProperty({ example: 5000000, nullable: true, type: Number })
  bitRate: number | null;

  @ApiProperty({ example: 29.97, nullable: true, type: Number })
  frameRate: number | null;
}

export class VideoChannelDto {
  @ApiProperty({ example: 'jdoe' })
  nickname: string;

  @ApiProperty({ example: 'jdoe' })
  name: string;
}

export class VideoResponseDto {
  @ApiProperty({ example: 'dQw4w9WgXcQ', description: '11-char public id' })
  id: string;

  @ApiProperty({ example: 'Trip to Rio' })
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ example: 'http://localhost:3000/videos/dQw4w9WgXcQ' })
  url: string;

  @ApiProperty({ example: 'trip-to-rio.mp4' })
  originalFilename: string;

  @ApiProperty({ example: 'video/mp4' })
  mimeType: string;

  @ApiProperty({ example: 10737418240 })
  sizeBytes: number;

  @ApiProperty({ example: 312.48, nullable: true, type: Number })
  durationSeconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({ nullable: true, type: String })
  thumbnailUrl: string | null;

  @ApiProperty({ nullable: true, type: String })
  streamUrl: string | null;

  @ApiProperty({ nullable: true, type: String })
  downloadUrl: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Failure reason — only returned to the owner',
  })
  processingError: string | null;

  @ApiProperty({ type: VideoChannelDto })
  channel: VideoChannelDto;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  processedAt: string | null;
}
