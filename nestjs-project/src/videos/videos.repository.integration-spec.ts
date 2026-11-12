import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { buildDraftInput, createTestChannel } from '../test/video-test-data';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import * as publicIdUtil from './public-id.util';
import { VideoStatus } from './video-status.enum';
import { PUBLIC_ID_MAX_RETRIES } from './videos.constants';
import { VideosRepository } from './videos.repository';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosRepository (integration)', () => {
  let dataSource: DataSource;
  let videosRepository: VideosRepository;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();

    const module = await Test.createTestingModule({
      providers: [
        VideosRepository,
        {
          provide: getRepositoryToken(Video),
          useValue: dataSource.getRepository(Video),
        },
      ],
    }).compile();
    videosRepository = module.get(VideosRepository);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createDraft', () => {
    it('should persist a draft with a generated public_id and derived storage_key', async () => {
      const channel = await createTestChannel(dataSource);

      const video = await videosRepository.createDraft(
        buildDraftInput(channel.id, { content_type: 'video/quicktime' }),
      );

      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(video.storage_key).toBe(`videos/${video.public_id}/original.mov`);
      const persisted = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: video.id });
      expect(persisted.storage_key).toBe(video.storage_key);
    });

    it('should retry with a new public_id when the generated one collides', async () => {
      const channel = await createTestChannel(dataSource);
      const first = await videosRepository.createDraft(
        buildDraftInput(channel.id),
      );
      const generator = jest
        .spyOn(publicIdUtil, 'generatePublicId')
        .mockReturnValueOnce(first.public_id)
        .mockReturnValueOnce(first.public_id)
        .mockReturnValueOnce('freshpubl_1');

      const second = await videosRepository.createDraft(
        buildDraftInput(channel.id),
      );

      expect(generator).toHaveBeenCalledTimes(3);
      expect(second.public_id).toBe('freshpubl_1');
      expect(second.storage_key).toBe('videos/freshpubl_1/original.mp4');
    });

    it('should propagate the unique violation after exhausting the retries', async () => {
      const channel = await createTestChannel(dataSource);
      const first = await videosRepository.createDraft(
        buildDraftInput(channel.id),
      );
      const generator = jest
        .spyOn(publicIdUtil, 'generatePublicId')
        .mockReturnValue(first.public_id);

      const attempt = videosRepository.createDraft(buildDraftInput(channel.id));

      await expect(attempt).rejects.toThrow(QueryFailedError);
      await expect(attempt).rejects.toMatchObject({
        driverError: { code: '23505' },
      });
      expect(generator).toHaveBeenCalledTimes(1 + PUBLIC_ID_MAX_RETRIES);
    });

    it('should not retry on errors other than a public_id collision', async () => {
      const generator = jest.spyOn(publicIdUtil, 'generatePublicId');

      const attempt = videosRepository.createDraft(
        buildDraftInput('00000000-0000-4000-8000-000000000000'),
      );

      await expect(attempt).rejects.toMatchObject({
        driverError: { code: '23503' },
      });
      expect(generator).toHaveBeenCalledTimes(1);
    });
  });

  describe('findById', () => {
    it('should find a video by its internal id and return null when unknown', async () => {
      const channel = await createTestChannel(dataSource);
      const draft = await videosRepository.createDraft(
        buildDraftInput(channel.id),
      );

      const found = await videosRepository.findById(draft.id);

      expect(found?.public_id).toBe(draft.public_id);
      expect(
        await videosRepository.findById('00000000-0000-4000-8000-000000000000'),
      ).toBeNull();
    });
  });

  describe('findByPublicId / findOwnedByPublicId', () => {
    it('should find a video by its public_id', async () => {
      const channel = await createTestChannel(dataSource);
      const draft = await videosRepository.createDraft(
        buildDraftInput(channel.id),
      );

      const found = await videosRepository.findByPublicId(draft.public_id);

      expect(found?.id).toBe(draft.id);
      expect(await videosRepository.findByPublicId('unknown_id_')).toBeNull();
    });

    it('should scope findOwnedByPublicId by channel', async () => {
      const owner = await createTestChannel(dataSource);
      const other = await createTestChannel(dataSource);
      const draft = await videosRepository.createDraft(
        buildDraftInput(owner.id),
      );

      const asOwner = await videosRepository.findOwnedByPublicId(
        draft.public_id,
        owner.id,
      );
      const asOther = await videosRepository.findOwnedByPublicId(
        draft.public_id,
        other.id,
      );

      expect(asOwner?.id).toBe(draft.id);
      expect(asOther).toBeNull();
    });
  });

  describe('setUploadId / deleteById', () => {
    it('should store the upload id of the draft', async () => {
      const channel = await createTestChannel(dataSource);
      const draft = await videosRepository.createDraft(
        buildDraftInput(channel.id),
      );

      await videosRepository.setUploadId(draft.id, 'upload-123');

      const found = await videosRepository.findByPublicId(draft.public_id);
      expect(found?.upload_id).toBe('upload-123');
    });

    it('should delete the video by id', async () => {
      const channel = await createTestChannel(dataSource);
      const draft = await videosRepository.createDraft(
        buildDraftInput(channel.id),
      );

      await videosRepository.deleteById(draft.id);

      expect(await videosRepository.findByPublicId(draft.public_id)).toBeNull();
    });
  });

  describe('transition', () => {
    it('should move the video and apply the patch when it is in the from state', async () => {
      const channel = await createTestChannel(dataSource);
      const draft = await videosRepository.createDraft(
        buildDraftInput(channel.id),
      );

      const changed = await videosRepository.transition(
        draft.id,
        VideoStatus.DRAFT,
        VideoStatus.PROCESSING,
        { size_bytes: 2048 },
      );

      expect(changed).toBe(true);
      const found = await videosRepository.findByPublicId(draft.public_id);
      expect(found?.status).toBe(VideoStatus.PROCESSING);
      expect(found?.size_bytes).toBe(2048);
    });

    it('should be a no-op returning false when the video is not in the from state', async () => {
      const channel = await createTestChannel(dataSource);
      const draft = await videosRepository.createDraft(
        buildDraftInput(channel.id),
      );
      await dataSource
        .getRepository(Video)
        .update({ id: draft.id }, { status: VideoStatus.READY });

      const changed = await videosRepository.transition(
        draft.id,
        VideoStatus.DRAFT,
        VideoStatus.PROCESSING,
        { size_bytes: 1 },
      );

      expect(changed).toBe(false);
      const found = await videosRepository.findByPublicId(draft.public_id);
      expect(found?.status).toBe(VideoStatus.READY);
      expect(found?.size_bytes).toBeNull();
    });

    it('should join the caller transaction when an entity manager is given', async () => {
      const channel = await createTestChannel(dataSource);
      const draft = await videosRepository.createDraft(
        buildDraftInput(channel.id),
      );

      await expect(
        dataSource.transaction(async (manager) => {
          const changed = await videosRepository.transition(
            draft.id,
            VideoStatus.DRAFT,
            VideoStatus.PROCESSING,
            {},
            manager,
          );
          expect(changed).toBe(true);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');

      const found = await videosRepository.findByPublicId(draft.public_id);
      expect(found?.status).toBe(VideoStatus.DRAFT);
    });
  });
});
