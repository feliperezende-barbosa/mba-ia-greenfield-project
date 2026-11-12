import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video-status.enum';

export class CompleteUploadResponseDto {
  @ApiProperty({ example: 'dQw4w9WgXcQ', description: '11-character id' })
  publicId: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.PROCESSING })
  status: VideoStatus;
}
