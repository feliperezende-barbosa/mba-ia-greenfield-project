import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video-status.enum';

export class CreateVideoResponseDto {
  @ApiProperty({ example: 'dQw4w9WgXcQ', description: '11-character id' })
  publicId: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ example: 'aula' })
  title: string;

  @ApiProperty({ example: 67108864, description: 'Size of each part in bytes' })
  partSize: number;

  @ApiProperty({ example: 3, description: 'Number of parts to upload' })
  partCount: number;
}
