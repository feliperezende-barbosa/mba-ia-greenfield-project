import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  MAX_VIDEO_SIZE_BYTES,
  VIDEO_CONTENT_TYPE_EXTENSIONS,
  VIDEO_FILENAME_MAX_LENGTH,
  VIDEO_TITLE_MAX_LENGTH,
  type VideoContentType,
} from '../videos.constants';

const ALLOWED_CONTENT_TYPES = Object.keys(
  VIDEO_CONTENT_TYPE_EXTENSIONS,
) as VideoContentType[];

export class CreateVideoDto {
  /** Original file name, used only for display and the default title. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(VIDEO_FILENAME_MAX_LENGTH)
  filename: string;

  /** Media type of the file; must be one of the supported video formats. */
  @IsIn(ALLOWED_CONTENT_TYPES)
  contentType: VideoContentType;

  /** File size in bytes (1 up to 10 GiB); only used to plan the part count. */
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  sizeBytes: number;

  /** Video title; defaults to the file name without its extension. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(VIDEO_TITLE_MAX_LENGTH)
  title?: string;
}
