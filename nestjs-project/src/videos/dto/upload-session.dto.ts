import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class UploadPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({
    description:
      'Presigned PUT URL. Send bytes [(partNumber-1)*partSize, partNumber*partSize) of the file.',
  })
  url: string;
}

export class UploadInstructionsDto {
  @ApiProperty({ example: 104857600, description: 'Part size in bytes' })
  partSize: number;

  @ApiProperty({ example: 103 })
  partCount: number;

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;

  @ApiProperty({ type: [UploadPartDto] })
  parts: UploadPartDto[];
}

export class UploadSessionDto {
  @ApiProperty({ example: 'dQw4w9WgXcQ', description: '11-char public id' })
  id: string;

  @ApiProperty({ example: 'Trip to Rio' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ example: 'http://localhost:3000/videos/dQw4w9WgXcQ' })
  url: string;

  @ApiProperty({ type: UploadInstructionsDto })
  upload: UploadInstructionsDto;
}
