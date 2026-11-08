import { Injectable, Logger } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { InvalidMediaError } from '../media/media.errors';
import { MediaService } from '../media/media.service';
import { PROCESS_VIDEO_JOB } from '../queue/video-processing.constants';
import type { ProcessVideoJobData } from '../queue/video-processing.types';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/video-status.enum';
import { buildThumbnailKey } from '../videos/video-keys.util';
import { PRESIGNED_URL_TTL_SECONDS } from '../videos/videos.constants';
import { VideosRepository } from '../videos/videos.repository';
import {
  INVALID_MEDIA_PREFIX,
  PROCESSING_FAILED_PREFIX,
  THUMBNAIL_CONTENT_TYPE,
} from './video-worker.constants';

function isUnrecoverable(error: Error): boolean {
  return (
    error instanceof UnrecoverableError || error.name === 'UnrecoverableError'
  );
}

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    private readonly videos: VideosRepository,
    private readonly storage: StorageService,
    private readonly media: MediaService,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.videos.findById(videoId);
    if (!video) {
      throw new UnrecoverableError(`Video ${videoId} not found`);
    }
    if (video.status !== VideoStatus.PROCESSING) {
      this.logger.log(
        `Skipping video ${video.public_id}: status is ${video.status}, not processing`,
      );
      return;
    }

    const sourceUrl = await this.storage.presignInternalGetUrl(
      video.storage_key,
      PRESIGNED_URL_TTL_SECONDS,
    );

    try {
      const { durationSeconds, metadata } = await this.media.probe(sourceUrl);
      const thumbnail = await this.media.generateThumbnail(
        sourceUrl,
        durationSeconds,
      );
      const thumbnailKey = buildThumbnailKey(video.public_id);
      await this.storage.putObject(
        thumbnailKey,
        thumbnail,
        THUMBNAIL_CONTENT_TYPE,
      );

      const transitioned = await this.videos.transition(
        video.id,
        VideoStatus.PROCESSING,
        VideoStatus.READY,
        {
          duration_seconds: durationSeconds,
          metadata,
          thumbnail_key: thumbnailKey,
        },
      );
      if (!transitioned) {
        this.logger.warn(
          `Video ${video.public_id} left processing before it could be marked ready`,
        );
      }
    } catch (error) {
      if (error instanceof InvalidMediaError) {
        throw new UnrecoverableError(`${INVALID_MEDIA_PREFIX} ${error.reason}`);
      }
      throw error;
    }
  }

  // Runs on every failed attempt (BullMQ `failed` event): a background context,
  // so errors are logged and never rethrown.
  async handleFailure(job: Job | undefined, error: Error): Promise<void> {
    if (!job || job.name !== PROCESS_VIDEO_JOB) {
      return;
    }
    const attemptsExhausted = job.attemptsMade >= (job.opts.attempts ?? 0);
    if (!isUnrecoverable(error) && !attemptsExhausted) {
      this.logger.warn(
        `Processing attempt ${job.attemptsMade} of job ${job.id} failed, will retry: ${error.message}`,
      );
      return;
    }

    const { videoId } = job.data as ProcessVideoJobData;
    const errorMessage = error.message.startsWith(INVALID_MEDIA_PREFIX)
      ? error.message
      : `${PROCESSING_FAILED_PREFIX} ${error.message}`;
    try {
      const transitioned = await this.videos.transition(
        videoId,
        VideoStatus.PROCESSING,
        VideoStatus.ERROR,
        { error_message: errorMessage },
      );
      if (!transitioned) {
        this.logger.warn(
          `Video ${videoId} was not in processing; error status not applied`,
        );
      }
    } catch (transitionError) {
      this.logger.error(
        `Could not mark video ${videoId} as error`,
        transitionError instanceof Error ? transitionError.stack : undefined,
      );
    }
  }
}
