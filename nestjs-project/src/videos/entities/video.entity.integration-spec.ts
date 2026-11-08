import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { createTestChannel } from '../../test/video-test-data';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from '../video-status.enum';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    const publicId = `pid_${String(++counter).padStart(7, '0')}`;
    return videoRepository.create({
      public_id: publicId,
      channel_id: channelId,
      title: 'Title',
      original_filename: 'file.mp4',
      content_type: 'video/mp4',
      storage_key: `videos/${publicId}/original.mp4`,
      part_count: 1,
      ...overrides,
    });
  }

  it('should default status to draft and leave optional columns null', async () => {
    const channel = await createTestChannel(dataSource);

    const saved = await videoRepository.save(buildVideo(channel.id));
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.thumbnail_key).toBeNull();
    expect(found.upload_id).toBeNull();
    expect(found.size_bytes).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.error_message).toBeNull();
    expect(found.created_at).toBeInstanceOf(Date);
    expect(found.updated_at).toBeInstanceOf(Date);
  });

  it('should enforce a unique public_id', async () => {
    const channel = await createTestChannel(dataSource);
    await videoRepository.save(
      buildVideo(channel.id, { public_id: 'dup_id_001' }),
    );

    const duplicate = videoRepository.save(
      buildVideo(channel.id, { public_id: 'dup_id_001' }),
    );

    await expect(duplicate).rejects.toThrow(QueryFailedError);
    await expect(duplicate).rejects.toMatchObject({
      driverError: { code: '23505' },
    });
  });

  it('should reject a channel_id that does not exist', async () => {
    const missingChannel = videoRepository.save(
      buildVideo('00000000-0000-4000-8000-000000000000'),
    );

    await expect(missingChannel).rejects.toMatchObject({
      driverError: { code: '23503' },
    });
  });

  it('should reject a status outside the video_status enum', async () => {
    const channel = await createTestChannel(dataSource);

    const invalid = videoRepository.save(
      buildVideo(channel.id, { status: 'archived' as VideoStatus }),
    );

    await expect(invalid).rejects.toMatchObject({
      driverError: { code: '22P02' },
    });
  });

  it('should round-trip the metadata jsonb column', async () => {
    const channel = await createTestChannel(dataSource);
    const metadata = {
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: null,
      bit_rate: 4_500_000,
      size_bytes: 1_234_567,
    };

    const saved = await videoRepository.save(
      buildVideo(channel.id, { metadata }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.metadata).toEqual(metadata);
  });

  it('should read size_bytes as a number', async () => {
    const channel = await createTestChannel(dataSource);
    const tenGiB = 10 * 1024 ** 3;

    const saved = await videoRepository.save(
      buildVideo(channel.id, { size_bytes: tenGiB }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe(tenGiB);
    expect(typeof found.size_bytes).toBe('number');
  });

  it('should load the videos of a channel through the inverse relation', async () => {
    const channel = await createTestChannel(dataSource);
    const saved = await videoRepository.save(buildVideo(channel.id));

    const found = await dataSource
      .getRepository(Channel)
      .findOneOrFail({ where: { id: channel.id }, relations: ['videos'] });

    expect(found.videos.map((video) => video.id)).toEqual([saved.id]);
  });
});
