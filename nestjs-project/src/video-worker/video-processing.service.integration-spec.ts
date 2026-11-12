import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { readFile } from 'node:fs/promises';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { MediaModule } from '../media/media.module';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  createMediaFixtures,
  FIXTURE_DURATION_SECONDS,
  removeMediaFixtures,
  type MediaFixtures,
} from '../test/media-fixtures';
import { deleteKeys } from '../test/storage-test-helpers';
import { buildDraftInput, createTestChannel } from '../test/video-test-data';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/video-status.enum';
import { VideosRepository } from '../videos/videos.repository';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingService (integration)', () => {
  let dataSource: DataSource;
  let module: TestingModule;
  let service: VideoProcessingService;
  let storage: StorageService;
  let fixtures: MediaFixtures;
  const createdKeys: string[] = [];

  async function createProcessingVideo(
    sourcePath: string,
    status: VideoStatus = VideoStatus.PROCESSING,
  ): Promise<Video> {
    const channel = await createTestChannel(dataSource);
    const videos = module.get(VideosRepository);
    const draft = await videos.createDraft(buildDraftInput(channel.id));
    createdKeys.push(
      draft.storage_key,
      `videos/${draft.public_id}/thumbnail.jpg`,
    );
    await storage.putObject(
      draft.storage_key,
      await readFile(sourcePath),
      draft.content_type,
    );
    await dataSource.getRepository(Video).update({ id: draft.id }, { status });
    return dataSource.getRepository(Video).findOneByOrFail({ id: draft.id });
  }

  function buildJob(video: Video, attemptsMade: number): Job {
    return {
      id: video.id,
      name: 'process-video',
      data: { videoId: video.id, publicId: video.public_id },
      attemptsMade,
      opts: { attempts: 3 },
    } as unknown as Job;
  }

  beforeAll(async () => {
    fixtures = await createMediaFixtures();
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, load: [storageConfig] }),
        StorageModule,
        MediaModule,
      ],
      providers: [
        VideoProcessingService,
        VideosRepository,
        {
          provide: getRepositoryToken(Video),
          useValue: dataSource.getRepository(Video),
        },
      ],
    }).compile();
    await module.init();
    service = module.get(VideoProcessingService);
    storage = module.get(StorageService);
  }, 60_000);

  afterAll(async () => {
    await deleteKeys(storage, createdKeys);
    await module.close();
    await dataSource.destroy();
    await removeMediaFixtures(fixtures);
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  it('should move a processing video to ready with duration, metadata and a stored thumbnail', async () => {
    const video = await createProcessingVideo(fixtures.mp4);

    await service.process(video.id);

    const processed = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.READY);
    expect(processed.duration_seconds).toBeCloseTo(FIXTURE_DURATION_SECONDS, 0);
    expect(processed.metadata).toEqual(
      expect.objectContaining({
        width: 320,
        height: 240,
        video_codec: 'h264',
        audio_codec: 'aac',
      }),
    );
    expect(processed.thumbnail_key).toBe(
      `videos/${video.public_id}/thumbnail.jpg`,
    );
    expect(processed.error_message).toBeNull();

    const thumbnailUrl = await storage.presignInternalGetUrl(
      processed.thumbnail_key!,
      60,
    );
    const response = await fetch(thumbnailUrl);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('should leave a video that is not processing untouched and upload no thumbnail', async () => {
    const video = await createProcessingVideo(fixtures.mp4, VideoStatus.READY);

    await service.process(video.id);

    const after = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(after.status).toBe(VideoStatus.READY);
    expect(after.updated_at.getTime()).toBe(video.updated_at.getTime());
    expect(after.thumbnail_key).toBeNull();
    expect(
      await storage.headObject(`videos/${video.public_id}/thumbnail.jpg`),
    ).toBeNull();
  });

  it.each([
    ['an audio-only file', 'audioOnly'],
    ['a text file', 'text'],
  ] as const)(
    'should fail %s with UnrecoverableError and handleFailure should move the video to error on attempt 1',
    async (_label, fixture) => {
      const video = await createProcessingVideo(fixtures[fixture]);

      const error: unknown = await service
        .process(video.id)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnrecoverableError);
      await service.handleFailure(buildJob(video, 1), error as Error);

      const after = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: video.id });
      expect(after.status).toBe(VideoStatus.ERROR);
      expect(after.error_message).toMatch(/^INVALID_MEDIA:/);
      expect(after.thumbnail_key).toBeNull();
    },
  );

  it('should keep the video processing after a retriable failure and error only on the last attempt', async () => {
    const video = await createProcessingVideo(fixtures.mp4);
    await storage.deleteObject(video.storage_key);

    const error: unknown = await service
      .process(video.id)
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(UnrecoverableError);

    await service.handleFailure(buildJob(video, 1), error as Error);
    expect(
      (await dataSource.getRepository(Video).findOneByOrFail({ id: video.id }))
        .status,
    ).toBe(VideoStatus.PROCESSING);

    await service.handleFailure(buildJob(video, 3), error as Error);
    const after = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(after.status).toBe(VideoStatus.ERROR);
    expect(after.error_message).toMatch(/^PROCESSING_FAILED:/);
  });
});
