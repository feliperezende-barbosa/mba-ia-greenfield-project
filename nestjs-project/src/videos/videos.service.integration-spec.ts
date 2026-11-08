import { ListMultipartUploadsCommand, type S3Client } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import {
  EmptyFileException,
  EnqueueFailedException,
  InvalidPartNumberException,
  UploadCompletionFailedException,
  VideoNotFoundException,
  VideoNotInDraftException,
} from '../common/exceptions/domain.exception';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/video-processing.constants';
import { QueueModule } from '../queue/queue.module';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import type { ProcessVideoJobData } from '../queue/video-processing.types';
import { S3_INTERNAL_CLIENT } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  deleteKeys,
  putPartsViaPresignedUrls,
} from '../test/storage-test-helpers';
import { createTestChannel } from '../test/video-test-data';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { VideosRepository } from './videos.repository';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const MIB = 1024 * 1024;

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let bucket: string;
  let queue: Queue<ProcessVideoJobData>;
  let producer: VideoProcessingProducer;
  const originalQueuePrefix = process.env.QUEUE_PREFIX;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `test-videos-service-${randomUUID()}`;
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, load: [storageConfig] }),
        StorageModule,
        QueueModule,
      ],
      providers: [
        VideosService,
        VideosRepository,
        ChannelsService,
        { provide: DataSource, useValue: dataSource },
        {
          provide: getRepositoryToken(Video),
          useValue: dataSource.getRepository(Video),
        },
      ],
    }).compile();
    await module.init();

    service = module.get(VideosService);
    storage = module.get(StorageService);
    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    bucket = module.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    ).bucket;
  });

  afterAll(async () => {
    await deleteKeys(storage, createdKeys);
    await queue.obliterate({ force: true });
    await module.close();
    await dataSource.destroy();
    if (originalQueuePrefix === undefined) {
      delete process.env.QUEUE_PREFIX;
    } else {
      process.env.QUEUE_PREFIX = originalQueuePrefix;
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function listOpenUploadIds(key: string): Promise<string[]> {
    const client = module.get<S3Client>(S3_INTERNAL_CLIENT);
    const response = await client.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }),
    );
    return (response.Uploads ?? [])
      .filter((upload) => upload.Key === key)
      .map((upload) => upload.UploadId as string);
  }

  describe('createDraft', () => {
    it('should persist a draft with upload id, storage key and part count and open the multipart upload', async () => {
      const channel = await createTestChannel(dataSource);

      const result = await service.createDraft(channel.user_id, {
        filename: 'aula.mp4',
        contentType: 'video/mp4',
        sizeBytes: 150 * MIB,
      });

      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: result.publicId });
      createdKeys.push(row.storage_key);
      expect(row).toMatchObject({
        channel_id: channel.id,
        status: VideoStatus.DRAFT,
        title: 'aula',
        original_filename: 'aula.mp4',
        content_type: 'video/mp4',
        storage_key: `videos/${result.publicId}/original.mp4`,
        part_count: 3,
      });
      expect(row.upload_id).toEqual(expect.any(String));
      expect(await listOpenUploadIds(row.storage_key)).toContain(row.upload_id);
      expect(result).toEqual({
        publicId: result.publicId,
        status: VideoStatus.DRAFT,
        title: 'aula',
        partSize: 64 * MIB,
        partCount: 3,
      });
    });

    it('should return distinct public ids for consecutive drafts', async () => {
      const channel = await createTestChannel(dataSource);
      const dto = {
        filename: 'a.webm',
        contentType: 'video/webm' as const,
        sizeBytes: MIB,
      };

      const first = await service.createDraft(channel.user_id, dto);
      const second = await service.createDraft(channel.user_id, dto);

      createdKeys.push(
        `videos/${first.publicId}/original.webm`,
        `videos/${second.publicId}/original.webm`,
      );
      expect(first.publicId).not.toBe(second.publicId);
    });

    it('should leave no orphan draft when the storage fails', async () => {
      const channel = await createTestChannel(dataSource);
      const failure = new Error('storage unavailable');
      jest.spyOn(storage, 'createMultipartUpload').mockRejectedValue(failure);

      await expect(
        service.createDraft(channel.user_id, {
          filename: 'aula.mp4',
          contentType: 'video/mp4',
          sizeBytes: MIB,
        }),
      ).rejects.toBe(failure);

      expect(await dataSource.getRepository(Video).count()).toBe(0);
    });
  });

  describe('getPartUrls', () => {
    it('should return URLs that accept real part bytes and answer an ETag', async () => {
      const channel = await createTestChannel(dataSource);
      const draft = await service.createDraft(channel.user_id, {
        filename: 'aula.mp4',
        contentType: 'video/mp4',
        sizeBytes: 5 * MIB,
      });
      createdKeys.push(`videos/${draft.publicId}/original.mp4`);

      const { expiresInSeconds, urls } = await service.getPartUrls(
        channel.user_id,
        draft.publicId,
        { partNumbers: [1] },
      );

      expect(expiresInSeconds).toBe(3600);
      expect(urls).toHaveLength(1);
      const publicEndpoint = new URL(
        module.get<ConfigType<typeof storageConfig>>(storageConfig.KEY)
          .publicEndpoint,
      );
      expect(new URL(urls[0].url).host).toBe(publicEndpoint.host);
      const parts = await putPartsViaPresignedUrls(
        urls,
        new Map([[1, Buffer.alloc(MIB, 7)]]),
      );
      expect(parts).toHaveLength(1);
      expect(parts[0].partNumber).toBe(1);
      expect(parts[0].etag).toBeTruthy();
    });

    it('should reject a part number above the planned part count', async () => {
      const channel = await createTestChannel(dataSource);
      const draft = await service.createDraft(channel.user_id, {
        filename: 'aula.mp4',
        contentType: 'video/mp4',
        sizeBytes: MIB,
      });
      createdKeys.push(`videos/${draft.publicId}/original.mp4`);

      await expect(
        service.getPartUrls(channel.user_id, draft.publicId, {
          partNumbers: [2],
        }),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
    });

    it('should hide the video of another channel as not found', async () => {
      const owner = await createTestChannel(dataSource);
      const stranger = await createTestChannel(dataSource);
      const draft = await service.createDraft(owner.user_id, {
        filename: 'aula.mp4',
        contentType: 'video/mp4',
        sizeBytes: MIB,
      });
      createdKeys.push(`videos/${draft.publicId}/original.mp4`);

      await expect(
        service.getPartUrls(stranger.user_id, draft.publicId, {
          partNumbers: [1],
        }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should reject a video that already left draft', async () => {
      const channel = await createTestChannel(dataSource);
      const draft = await service.createDraft(channel.user_id, {
        filename: 'aula.mp4',
        contentType: 'video/mp4',
        sizeBytes: MIB,
      });
      createdKeys.push(`videos/${draft.publicId}/original.mp4`);
      await dataSource
        .getRepository(Video)
        .update(
          { public_id: draft.publicId },
          { status: VideoStatus.PROCESSING },
        );

      await expect(
        service.getPartUrls(channel.user_id, draft.publicId, {
          partNumbers: [1],
        }),
      ).rejects.toBeInstanceOf(VideoNotInDraftException);
    });
  });

  describe('completeUpload', () => {
    // The declared size only plans the parts: 64 MiB + 1 byte plans 2 parts.
    async function createTwoPartDraft(userId: string): Promise<string> {
      const draft = await service.createDraft(userId, {
        filename: 'aula.mp4',
        contentType: 'video/mp4',
        sizeBytes: 64 * MIB + 1,
      });
      createdKeys.push(`videos/${draft.publicId}/original.mp4`);
      return draft.publicId;
    }

    async function uploadParts(
      userId: string,
      publicId: string,
      sizes: number[],
    ): Promise<{ partNumber: number; etag: string }[]> {
      const partNumbers = sizes.map((_size, index) => index + 1);
      const { urls } = await service.getPartUrls(userId, publicId, {
        partNumbers,
      });
      const bodies = new Map(
        sizes.map((size, index) => [index + 1, Buffer.alloc(size, index + 1)]),
      );
      return putPartsViaPresignedUrls(urls, bodies);
    }

    async function findVideo(publicId: string): Promise<Video> {
      return dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: publicId });
    }

    async function objectExists(key: string): Promise<boolean> {
      return (await storage.headObject(key)) !== null;
    }

    it('should move to processing with the real size and publish the job with the video uuid', async () => {
      const channel = await createTestChannel(dataSource);
      const publicId = await createTwoPartDraft(channel.user_id);
      const parts = await uploadParts(channel.user_id, publicId, [
        5 * MIB,
        MIB,
      ]);

      const result = await service.completeUpload(channel.user_id, publicId, {
        parts,
      });

      expect(result).toEqual({
        publicId,
        status: VideoStatus.PROCESSING,
      });
      const video = await findVideo(publicId);
      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(video.size_bytes).toBe(6 * MIB);
      expect(await objectExists(video.storage_key)).toBe(true);
      const job = await queue.getJob(video.id);
      expect(job).toBeDefined();
      expect(job!.name).toBe(PROCESS_VIDEO_JOB);
      expect(job!.data).toEqual({ videoId: video.id, publicId });
    });

    it('should reject a repeated completion without publishing a second job', async () => {
      const channel = await createTestChannel(dataSource);
      const publicId = await createTwoPartDraft(channel.user_id);
      const parts = await uploadParts(channel.user_id, publicId, [
        5 * MIB,
        MIB,
      ]);
      await service.completeUpload(channel.user_id, publicId, { parts });

      await expect(
        service.completeUpload(channel.user_id, publicId, { parts }),
      ).rejects.toBeInstanceOf(VideoNotInDraftException);

      const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
      expect(counts.waiting).toBe(1);
    });

    it('should keep the draft when an ETag is invalid so the client can retry', async () => {
      const channel = await createTestChannel(dataSource);
      const publicId = await createTwoPartDraft(channel.user_id);
      const parts = await uploadParts(channel.user_id, publicId, [
        5 * MIB,
        MIB,
      ]);

      await expect(
        service.completeUpload(channel.user_id, publicId, {
          parts: [parts[0], { partNumber: 2, etag: '"deadbeef"' }],
        }),
      ).rejects.toBeInstanceOf(UploadCompletionFailedException);

      expect((await findVideo(publicId)).status).toBe(VideoStatus.DRAFT);
      await expect(
        service.completeUpload(channel.user_id, publicId, { parts }),
      ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });
    });

    it('should mark an empty object as error and remove it from the storage', async () => {
      const channel = await createTestChannel(dataSource);
      const draft = await service.createDraft(channel.user_id, {
        filename: 'empty.mp4',
        contentType: 'video/mp4',
        sizeBytes: MIB,
      });
      createdKeys.push(`videos/${draft.publicId}/original.mp4`);
      const parts = await uploadParts(channel.user_id, draft.publicId, [0]);

      await expect(
        service.completeUpload(channel.user_id, draft.publicId, { parts }),
      ).rejects.toBeInstanceOf(EmptyFileException);

      const video = await findVideo(draft.publicId);
      expect(video.status).toBe(VideoStatus.ERROR);
      expect(video.error_message).toMatch(/^EMPTY_FILE/);
      expect(await objectExists(video.storage_key)).toBe(false);
      expect(await queue.getJob(video.id)).toBeUndefined();
    });

    it('should mark the video as error with ENQUEUE_FAILED when publishing fails', async () => {
      const channel = await createTestChannel(dataSource);
      const publicId = await createTwoPartDraft(channel.user_id);
      const parts = await uploadParts(channel.user_id, publicId, [
        5 * MIB,
        MIB,
      ]);
      jest
        .spyOn(producer, 'enqueue')
        .mockRejectedValue(new Error('redis down'));

      await expect(
        service.completeUpload(channel.user_id, publicId, { parts }),
      ).rejects.toBeInstanceOf(EnqueueFailedException);

      const video = await findVideo(publicId);
      expect(video.status).toBe(VideoStatus.ERROR);
      expect(video.error_message).toMatch(/^ENQUEUE_FAILED/);
    });
  });

  describe('getOwnedVideo', () => {
    it('should return a thumbnailUrl that downloads the stored thumbnail from the public endpoint', async () => {
      const channel = await createTestChannel(dataSource);
      const draft = await service.createDraft(channel.user_id, {
        filename: 'aula.mp4',
        contentType: 'video/mp4',
        sizeBytes: MIB,
      });
      const thumbnailKey = `videos/${draft.publicId}/thumbnail.jpg`;
      createdKeys.push(`videos/${draft.publicId}/original.mp4`, thumbnailKey);
      const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.alloc(64, 7),
      ]);
      await storage.putObject(thumbnailKey, jpeg, 'image/jpeg');
      await dataSource.getRepository(Video).update(
        { public_id: draft.publicId },
        {
          status: VideoStatus.READY,
          duration_seconds: 3,
          thumbnail_key: thumbnailKey,
        },
      );

      const result = await service.getOwnedVideo(
        channel.user_id,
        draft.publicId,
      );

      expect(result.status).toBe(VideoStatus.READY);
      expect(result.durationSeconds).toBe(3);
      const publicEndpoint = new URL(process.env.S3_PUBLIC_ENDPOINT!);
      expect(new URL(result.thumbnailUrl!).host).toBe(publicEndpoint.host);
      const response = await fetch(result.thumbnailUrl!);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/jpeg');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(jpeg);
    });

    it('should return null thumbnailUrl for a draft and hide videos of other channels', async () => {
      const owner = await createTestChannel(dataSource);
      const other = await createTestChannel(dataSource);
      const draft = await service.createDraft(owner.user_id, {
        filename: 'aula.mp4',
        contentType: 'video/mp4',
        sizeBytes: MIB,
      });
      createdKeys.push(`videos/${draft.publicId}/original.mp4`);

      const result = await service.getOwnedVideo(owner.user_id, draft.publicId);

      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.thumbnailUrl).toBeNull();
      await expect(
        service.getOwnedVideo(other.user_id, draft.publicId),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});
