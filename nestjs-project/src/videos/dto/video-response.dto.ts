import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video-status.enum';

export class VideoMetadataDto {
  @ApiProperty({ example: 'mov,mp4,m4a,3gp,3g2,mj2', nullable: true })
  container: string | null;

  @ApiProperty({ example: 1920, nullable: true })
  width: number | null;

  @ApiProperty({ example: 1080, nullable: true })
  height: number | null;

  @ApiProperty({ example: 'h264', nullable: true })
  video_codec: string | null;

  @ApiProperty({ example: 'aac', nullable: true })
  audio_codec: string | null;

  @ApiProperty({ example: 2500000, nullable: true })
  bit_rate: number | null;

  @ApiProperty({ example: 52428800, nullable: true })
  size_bytes: number | null;
}

export class VideoResponseDto {
  @ApiProperty({ example: 'dQw4w9WgXcQ', description: '11-character id' })
  publicId: string;

  @ApiProperty({ example: 'My first video' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({ example: 'holiday.mp4' })
  originalFilename: string;

  @ApiProperty({ example: 'video/mp4' })
  contentType: string;

  @ApiProperty({
    required: false,
    nullable: true,
    type: Number,
    example: 52428800,
    description: 'Actual size in bytes; null until the upload is completed',
  })
  sizeBytes: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: Number,
    example: 12.5,
    description: 'Duration in seconds; null until the video is ready',
  })
  durationSeconds: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: () => VideoMetadataDto,
    description: 'Media metadata; null until the video is ready',
  })
  metadata: VideoMetadataDto | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    example: 'INVALID_MEDIA: no video stream found',
    description: 'Failure reason; populated when status is error',
  })
  errorMessage: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    description:
      'Presigned GET URL of the thumbnail (valid for 1 hour); null until the video is ready',
  })
  thumbnailUrl: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: string;
}
