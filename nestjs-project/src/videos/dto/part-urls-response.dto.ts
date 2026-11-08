import { ApiProperty } from '@nestjs/swagger';

export class PartUrlDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({
    example: 'http://localhost:9000/streamtube/videos/abc/original.mp4?...',
    description: 'Presigned URL to PUT the raw part bytes to',
  })
  url: string;
}

export class PartUrlsResponseDto {
  @ApiProperty({ example: 3600 })
  expiresInSeconds: number;

  @ApiProperty({ type: [PartUrlDto] })
  urls: PartUrlDto[];
}
