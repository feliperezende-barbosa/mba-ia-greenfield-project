import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  EmptyFileException,
  EnqueueFailedException,
  FileTooLargeException,
  InvalidPartNumberException,
  UploadCompletionFailedException,
  VideoNotFoundException,
  VideoNotInDraftException,
} from '../common/exceptions/domain.exception';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import { InvalidMultipartUploadError } from '../storage/storage.errors';
import {
  type CompletedPartInput,
  StorageService,
} from '../storage/storage.service';
import type { CompleteUploadDto } from './dto/complete-upload.dto';
import type { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { PartUrlsRequestDto } from './dto/part-urls-request.dto';
import type { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import type { Video } from './entities/video.entity';
import { planUploadParts } from './upload-plan.util';
import { deriveTitle } from './video-title.util';
import { VideoStatus } from './video-status.enum';
import {
  MAX_VIDEO_SIZE_BYTES,
  PRESIGNED_URL_TTL_SECONDS,
} from './videos.constants';
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
  private readonly logger = new Logger(VideosService.name);

  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly storage: StorageService,
    private readonly channelsService: ChannelsService,
    private readonly videoProcessingProducer: VideoProcessingProducer,
    private readonly dataSource: DataSource,
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

  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.getOwnedDraft(userId, publicId);
    this.assertPartNumbersInRange(
      dto.parts.map((part) => part.partNumber),
      video.part_count,
    );

    await this.completeStorageUpload(video, dto.parts);
    const sizeBytes = await this.verifyUploadedObject(video);

    await this.dataSource.transaction(async (manager) => {
      const moved = await this.videosRepository.transition(
        video.id,
        VideoStatus.DRAFT,
        VideoStatus.PROCESSING,
        { size_bytes: sizeBytes },
        manager,
      );
      if (!moved) {
        throw new VideoNotInDraftException();
      }
    });

    await this.publishProcessingJob(video);
    return { publicId: video.public_id, status: VideoStatus.PROCESSING };
  }

  private async completeStorageUpload(
    video: Video,
    parts: CompletedPartInput[],
  ): Promise<void> {
    try {
      await this.storage.completeMultipartUpload(
        video.storage_key,
        this.requireUploadId(video),
        parts,
      );
    } catch (error) {
      if (!(error instanceof InvalidMultipartUploadError)) {
        throw error;
      }
      // A retry after a lost response finds the upload already completed: the object exists.
      const alreadyCompleted =
        error.reason === 'NoSuchUpload' &&
        (await this.storage.headObject(video.storage_key)) !== null;
      if (!alreadyCompleted) {
        throw new UploadCompletionFailedException();
      }
    }
  }

  private async verifyUploadedObject(video: Video): Promise<number> {
    const object = await this.storage.headObject(video.storage_key);
    if (!object) {
      throw new UploadCompletionFailedException();
    }
    if (object.contentLength > MAX_VIDEO_SIZE_BYTES) {
      await this.rejectUploadedObject(
        video,
        `FILE_TOO_LARGE: object has ${object.contentLength} bytes (limit ${MAX_VIDEO_SIZE_BYTES})`,
      );
      throw new FileTooLargeException();
    }
    if (object.contentLength === 0) {
      await this.rejectUploadedObject(video, 'EMPTY_FILE: object has 0 bytes');
      throw new EmptyFileException();
    }
    return object.contentLength;
  }

  private async rejectUploadedObject(
    video: Video,
    errorMessage: string,
  ): Promise<void> {
    await this.storage.deleteObject(video.storage_key);
    await this.videosRepository.transition(
      video.id,
      VideoStatus.DRAFT,
      VideoStatus.ERROR,
      { error_message: errorMessage },
    );
  }

  private async publishProcessingJob(video: Video): Promise<void> {
    try {
      await this.videoProcessingProducer.enqueue(video);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Publishing the processing job of video ${video.public_id} failed: ${detail}`,
      );
      await this.videosRepository.transition(
        video.id,
        VideoStatus.PROCESSING,
        VideoStatus.ERROR,
        { error_message: `ENQUEUE_FAILED: ${detail}` },
      );
      throw new EnqueueFailedException();
    }
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
