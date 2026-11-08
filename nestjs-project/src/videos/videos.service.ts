import { Injectable } from '@nestjs/common';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import { planUploadParts } from './upload-plan.util';
import { deriveTitle } from './video-title.util';
import { VideoStatus } from './video-status.enum';
import { VideosRepository } from './videos.repository';

export interface CreatedDraft {
  publicId: string;
  status: VideoStatus;
  title: string;
  partSize: number;
  partCount: number;
}

@Injectable()
export class VideosService {
  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly storage: StorageService,
    private readonly channelsService: ChannelsService,
  ) {}

  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreatedDraft> {
    const channel = await this.channelsService.getByUserId(userId);
    const { partSize, partCount } = planUploadParts(dto.sizeBytes);
    const title = dto.title ?? deriveTitle(dto.filename);

    const video = await this.videosRepository.createDraft({
      channel_id: channel.id,
      title,
      original_filename: dto.filename,
      content_type: dto.contentType,
      part_count: partCount,
    });

    try {
      const uploadId = await this.storage.createMultipartUpload(
        video.storage_key,
        dto.contentType,
      );
      await this.videosRepository.setUploadId(video.id, uploadId);
    } catch (error) {
      // Compensation: no orphan draft without a multipart upload behind it.
      await this.videosRepository.deleteById(video.id);
      throw error;
    }

    return {
      publicId: video.public_id,
      status: video.status,
      title: video.title,
      partSize,
      partCount,
    };
  }
}
