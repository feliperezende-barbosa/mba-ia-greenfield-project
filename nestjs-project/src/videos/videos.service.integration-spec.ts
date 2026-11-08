import { ListMultipartUploadsCommand, type S3Client } from '@aws-sdk/client-s3';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { deleteKeys } from '../test/storage-test-helpers';
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
  const createdKeys: string[] = [];

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, load: [storageConfig] }),
        StorageModule,
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
    bucket = module.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    ).bucket;
  });

  afterAll(async () => {
    await deleteKeys(storage, createdKeys);
    await module.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
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
});
