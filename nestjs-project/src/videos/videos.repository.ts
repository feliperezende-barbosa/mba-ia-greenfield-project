import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { Video } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { buildOriginalKey } from './video-keys.util';
import { VideoStatus } from './video-status.enum';
import {
  PUBLIC_ID_MAX_RETRIES,
  VIDEO_CONTENT_TYPE_EXTENSIONS,
  type VideoContentType,
} from './videos.constants';

const UNIQUE_VIOLATION_CODE = '23505';

export interface CreateDraftInput {
  channel_id: string;
  title: string;
  original_filename: string;
  content_type: VideoContentType;
  part_count: number;
}

export type VideoTransitionPatch = Partial<
  Pick<
    Video,
    | 'size_bytes'
    | 'duration_seconds'
    | 'metadata'
    | 'thumbnail_key'
    | 'error_message'
  >
>;

function isPublicIdCollision(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driverError = error.driverError as
    | { code?: string; detail?: string }
    | undefined;
  return (
    driverError?.code === UNIQUE_VIOLATION_CODE &&
    (driverError.detail ?? '').includes('(public_id)')
  );
}

@Injectable()
export class VideosRepository {
  constructor(
    @InjectRepository(Video)
    private readonly repository: Repository<Video>,
  ) {}

  // Standalone insert (no wrapping transaction), so a collision needs no savepoint.
  async createDraft(input: CreateDraftInput): Promise<Video> {
    const extension = VIDEO_CONTENT_TYPE_EXTENSIONS[input.content_type];

    for (let attempt = 1; ; attempt++) {
      const publicId = generatePublicId();
      const draft = this.repository.create({
        ...input,
        public_id: publicId,
        storage_key: buildOriginalKey(publicId, extension),
      });
      try {
        return await this.repository.save(draft, { transaction: false });
      } catch (error) {
        if (!isPublicIdCollision(error) || attempt > PUBLIC_ID_MAX_RETRIES) {
          throw error;
        }
      }
    }
  }

  async findByPublicId(publicId: string): Promise<Video | null> {
    return this.repository.findOne({ where: { public_id: publicId } });
  }

  async findOwnedByPublicId(
    publicId: string,
    channelId: string,
  ): Promise<Video | null> {
    return this.repository.findOne({
      where: { public_id: publicId, channel_id: channelId },
    });
  }

  async setUploadId(id: string, uploadId: string): Promise<void> {
    await this.repository.update({ id }, { upload_id: uploadId });
  }

  async transition(
    id: string,
    from: VideoStatus,
    to: VideoStatus,
    patch: VideoTransitionPatch = {},
    manager?: EntityManager,
  ): Promise<boolean> {
    const repository = manager ? manager.getRepository(Video) : this.repository;
    const result = await repository.update(
      { id, status: from },
      { ...patch, status: to },
    );
    return result.affected === 1;
  }

  async deleteById(id: string): Promise<void> {
    await this.repository.delete({ id });
  }
}
