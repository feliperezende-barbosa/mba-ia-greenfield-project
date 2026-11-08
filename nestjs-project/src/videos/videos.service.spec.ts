import { Test } from '@nestjs/testing';
import { ChannelsService } from '../channels/channels.service';
import { ChannelNotFoundException } from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { VideosRepository } from './videos.repository';
import { VideosService } from './videos.service';

const USER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';
const MIB = 1024 ** 2;

function buildVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-uuid',
    public_id: 'AbCdEfGh_-1',
    channel_id: CHANNEL_ID,
    title: 'aula',
    status: VideoStatus.DRAFT,
    storage_key: 'videos/AbCdEfGh_-1/original.mp4',
    ...overrides,
  } as Video;
}

describe('VideosService', () => {
  let service: VideosService;
  let videosRepository: jest.Mocked<
    Pick<VideosRepository, 'createDraft' | 'setUploadId' | 'deleteById'>
  >;
  let storage: jest.Mocked<Pick<StorageService, 'createMultipartUpload'>>;
  let channelsService: jest.Mocked<Pick<ChannelsService, 'getByUserId'>>;

  beforeEach(async () => {
    videosRepository = {
      createDraft: jest.fn().mockResolvedValue(buildVideo()),
      setUploadId: jest.fn().mockResolvedValue(undefined),
      deleteById: jest.fn().mockResolvedValue(undefined),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
    };
    channelsService = {
      getByUserId: jest.fn().mockResolvedValue({ id: CHANNEL_ID }),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: VideosRepository, useValue: videosRepository },
        { provide: StorageService, useValue: storage },
        { provide: ChannelsService, useValue: channelsService },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('createDraft', () => {
    const dto = {
      filename: 'aula.mp4',
      contentType: 'video/mp4' as const,
      sizeBytes: 150 * MIB,
    };

    it('should create the draft in the user channel with the derived title and part plan', async () => {
      const result = await service.createDraft(USER_ID, dto);

      expect(channelsService.getByUserId).toHaveBeenCalledWith(USER_ID);
      expect(videosRepository.createDraft).toHaveBeenCalledWith({
        channel_id: CHANNEL_ID,
        title: 'aula',
        original_filename: 'aula.mp4',
        content_type: 'video/mp4',
        part_count: 3,
      });
      expect(result).toEqual({
        publicId: 'AbCdEfGh_-1',
        status: VideoStatus.DRAFT,
        title: 'aula',
        partSize: 64 * MIB,
        partCount: 3,
      });
    });

    it('should persist the informed title instead of deriving it', async () => {
      videosRepository.createDraft.mockResolvedValue(
        buildVideo({ title: 'Custom title' }),
      );

      const result = await service.createDraft(USER_ID, {
        ...dto,
        title: 'Custom title',
      });

      expect(videosRepository.createDraft).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Custom title' }),
      );
      expect(result.title).toBe('Custom title');
    });

    it('should start the multipart upload for the storage key and save its upload id', async () => {
      await service.createDraft(USER_ID, dto);

      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        'videos/AbCdEfGh_-1/original.mp4',
        'video/mp4',
      );
      expect(videosRepository.setUploadId).toHaveBeenCalledWith(
        'video-uuid',
        'upload-1',
      );
    });

    it('should delete the new draft and rethrow when the storage fails', async () => {
      const storageError = new Error('storage down');
      storage.createMultipartUpload.mockRejectedValue(storageError);

      await expect(service.createDraft(USER_ID, dto)).rejects.toBe(
        storageError,
      );

      expect(videosRepository.deleteById).toHaveBeenCalledWith('video-uuid');
      expect(videosRepository.setUploadId).not.toHaveBeenCalled();
    });

    it('should propagate ChannelNotFoundException without creating anything', async () => {
      channelsService.getByUserId.mockRejectedValue(
        new ChannelNotFoundException(),
      );

      await expect(service.createDraft(USER_ID, dto)).rejects.toBeInstanceOf(
        ChannelNotFoundException,
      );

      expect(videosRepository.createDraft).not.toHaveBeenCalled();
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });
  });
});
