import { Injectable } from '@nestjs/common';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidPartNumberException,
  VideoNotFoundException,
  VideoNotInDraftException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { PartUrlsRequestDto } from './dto/part-urls-request.dto';
import type { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import type { Video } from './entities/video.entity';
import { planUploadParts } from './upload-plan.util';
import { deriveTitle } from './video-title.util';
import { VideoStatus } from './video-status.enum';
import { PRESIGNED_URL_TTL_SECONDS } from './videos.constants';
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

  async getPartUrls(
    userId: string,
    publicId: string,
    dto: PartUrlsRequestDto,
  ): Promise<PartUrlsResponseDto> {
    const video = await this.getOwnedDraft(userId, publicId);
    this.assertPartNumbersInRange(dto.partNumbers, video.part_count);

    const urls = await this.storage.presignUploadPartUrls(
      video.storage_key,
      this.requireUploadId(video),
      dto.partNumbers,
    );
    return { expiresInSeconds: PRESIGNED_URL_TTL_SECONDS, urls };
  }

  // Unknown video and video of another channel are indistinguishable on purpose.
  private async getOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const channel = await this.channelsService.getByUserId(userId);
    const video = await this.videosRepository.findOwnedByPublicId(
      publicId,
      channel.id,
    );
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async getOwnedDraft(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.getOwnedVideo(userId, publicId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotInDraftException();
    }
    return video;
  }

  private assertPartNumbersInRange(
    partNumbers: number[],
    partCount: number,
  ): void {
    if (partNumbers.some((partNumber) => partNumber > partCount)) {
      throw new InvalidPartNumberException();
    }
  }

  private requireUploadId(video: Video): string {
    if (!video.upload_id) {
      throw new Error(`Draft video ${video.public_id} has no multipart upload`);
    }
    return video.upload_id;
  }
}
