import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';

export class CreateVideoDto {
  /** Original file name, used for the default title and the download name. */
  @IsString()
  @Length(1, 255)
  fileName: string;

  /** Exact file size in bytes (validated against UPLOAD_MAX_SIZE_BYTES). */
  @IsInt()
  @Min(1)
  fileSize: number;

  /**
   * MIME type of the file; must be a video type.
   * @example 'video/mp4'
   */
  @IsString()
  @Matches(/^video\/[\w.+-]+$/, {
    message: 'contentType must be a video MIME type (video/*)',
  })
  contentType: string;

  /** Optional title; defaults to the file name without its extension. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  title?: string;
}
