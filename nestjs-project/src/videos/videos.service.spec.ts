import { Test } from '@nestjs/testing';
import { ChannelsService } from '../channels/channels.service';
import { DataSource } from 'typeorm';
import {
  ChannelNotFoundException,
  EmptyFileException,
  EnqueueFailedException,
  FileTooLargeException,
  InvalidPartNumberException,
  UploadCompletionFailedException,
  VideoNotFoundException,
  VideoNotInDraftException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import { InvalidMultipartUploadError } from '../storage/storage.errors';
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
    Pick<
      VideosRepository,
      | 'createDraft'
      | 'setUploadId'
      | 'deleteById'
      | 'findOwnedByPublicId'
      | 'findByPublicId'
      | 'transition'
    >
  >;
  let storage: jest.Mocked<
    Pick<
      StorageService,
      | 'createMultipartUpload'
      | 'presignUploadPartUrls'
      | 'completeMultipartUpload'
      | 'headObject'
      | 'deleteObject'
      | 'presignPublicGetUrl'
    >
  >;
  let producer: jest.Mocked<Pick<VideoProcessingProducer, 'enqueue'>>;
  const mockManager = {};
  let channelsService: jest.Mocked<Pick<ChannelsService, 'getByUserId'>>;

  beforeEach(async () => {
    videosRepository = {
      createDraft: jest.fn().mockResolvedValue(buildVideo()),
      setUploadId: jest.fn().mockResolvedValue(undefined),
      deleteById: jest.fn().mockResolvedValue(undefined),
      findOwnedByPublicId: jest.fn(),
      findByPublicId: jest.fn(),
      transition: jest.fn().mockResolvedValue(true),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      presignUploadPartUrls: jest.fn(),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({ contentLength: 10 * MIB }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      presignPublicGetUrl: jest.fn(),
    };
    producer = { enqueue: jest.fn().mockResolvedValue(undefined) };
    channelsService = {
      getByUserId: jest.fn().mockResolvedValue({ id: CHANNEL_ID }),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: VideosRepository, useValue: videosRepository },
        { provide: StorageService, useValue: storage },
        { provide: ChannelsService, useValue: channelsService },
        { provide: VideoProcessingProducer, useValue: producer },
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn((callback: (manager: object) => unknown) =>
              callback(mockManager),
            ),
          },
        },
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

  describe('getPartUrls', () => {
    const draft = buildVideo({ upload_id: 'upload-1', part_count: 3 });

    beforeEach(() => {
      videosRepository.findOwnedByPublicId.mockResolvedValue(draft);
      storage.presignUploadPartUrls.mockResolvedValue([
        { partNumber: 1, url: 'http://storage/1' },
        { partNumber: 3, url: 'http://storage/3' },
      ]);
    });

    it('should presign the requested parts of the owned draft', async () => {
      const result = await service.getPartUrls(USER_ID, 'AbCdEfGh_-1', {
        partNumbers: [1, 3],
      });

      expect(videosRepository.findOwnedByPublicId).toHaveBeenCalledWith(
        'AbCdEfGh_-1',
        CHANNEL_ID,
      );
      expect(storage.presignUploadPartUrls).toHaveBeenCalledWith(
        'videos/AbCdEfGh_-1/original.mp4',
        'upload-1',
        [1, 3],
      );
      expect(result).toEqual({
        expiresInSeconds: 3600,
        urls: [
          { partNumber: 1, url: 'http://storage/1' },
          { partNumber: 3, url: 'http://storage/3' },
        ],
      });
    });

    it('should throw VideoNotFoundException when the video is unknown or not owned', async () => {
      videosRepository.findOwnedByPublicId.mockResolvedValue(null);

      await expect(
        service.getPartUrls(USER_ID, 'AbCdEfGh_-1', { partNumbers: [1] }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storage.presignUploadPartUrls).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.ERROR])(
      'should throw VideoNotInDraftException when the video is %s',
      async (status) => {
        videosRepository.findOwnedByPublicId.mockResolvedValue(
          buildVideo({ status, upload_id: 'upload-1', part_count: 3 }),
        );

        await expect(
          service.getPartUrls(USER_ID, 'AbCdEfGh_-1', { partNumbers: [1] }),
        ).rejects.toBeInstanceOf(VideoNotInDraftException);
      },
    );

    it('should throw InvalidPartNumberException when a part number exceeds the part count', async () => {
      await expect(
        service.getPartUrls(USER_ID, 'AbCdEfGh_-1', { partNumbers: [1, 4] }),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(storage.presignUploadPartUrls).not.toHaveBeenCalled();
    });

    it('should accept the last part number equal to the part count', async () => {
      await expect(
        service.getPartUrls(USER_ID, 'AbCdEfGh_-1', { partNumbers: [3] }),
      ).resolves.toBeDefined();
    });
  });

  describe('completeUpload', () => {
    const parts = [
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
    ];
    const draft = buildVideo({ upload_id: 'upload-1', part_count: 2 });

    beforeEach(() => {
      videosRepository.findOwnedByPublicId.mockResolvedValue(draft);
    });

    it('should complete, check the size, move to processing and enqueue in this order', async () => {
      const result = await service.completeUpload(USER_ID, 'AbCdEfGh_-1', {
        parts,
      });

      expect(result).toEqual({
        publicId: 'AbCdEfGh_-1',
        status: VideoStatus.PROCESSING,
      });
      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/AbCdEfGh_-1/original.mp4',
        'upload-1',
        parts,
      );
      expect(videosRepository.transition).toHaveBeenCalledWith(
        'video-uuid',
        VideoStatus.DRAFT,
        VideoStatus.PROCESSING,
        { size_bytes: 10 * MIB },
        mockManager,
      );
      expect(producer.enqueue).toHaveBeenCalledWith(draft);
      const order = [
        storage.completeMultipartUpload,
        storage.headObject,
        videosRepository.transition,
        producer.enqueue,
      ].map((mock) => mock.mock.invocationCallOrder[0]);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('should continue when the upload was already completed and the object exists', async () => {
      storage.completeMultipartUpload.mockRejectedValue(
        new InvalidMultipartUploadError('NoSuchUpload'),
      );

      await expect(
        service.completeUpload(USER_ID, 'AbCdEfGh_-1', { parts }),
      ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });
      expect(producer.enqueue).toHaveBeenCalled();
    });

    it('should fail with UploadCompletionFailedException when NoSuchUpload has no object', async () => {
      storage.completeMultipartUpload.mockRejectedValue(
        new InvalidMultipartUploadError('NoSuchUpload'),
      );
      storage.headObject.mockResolvedValue(null);

      await expect(
        service.completeUpload(USER_ID, 'AbCdEfGh_-1', { parts }),
      ).rejects.toBeInstanceOf(UploadCompletionFailedException);
      expect(videosRepository.transition).not.toHaveBeenCalled();
    });

    it.each(['InvalidPart', 'InvalidPartOrder', 'EntityTooSmall'])(
      'should fail with UploadCompletionFailedException on %s and keep the draft',
      async (reason) => {
        storage.completeMultipartUpload.mockRejectedValue(
          new InvalidMultipartUploadError(reason),
        );

        await expect(
          service.completeUpload(USER_ID, 'AbCdEfGh_-1', { parts }),
        ).rejects.toBeInstanceOf(UploadCompletionFailedException);
        expect(storage.headObject).not.toHaveBeenCalled();
        expect(videosRepository.transition).not.toHaveBeenCalled();
        expect(producer.enqueue).not.toHaveBeenCalled();
      },
    );

    it('should propagate unexpected storage errors untouched', async () => {
      const failure = new Error('storage down');
      storage.completeMultipartUpload.mockRejectedValue(failure);

      await expect(
        service.completeUpload(USER_ID, 'AbCdEfGh_-1', { parts }),
      ).rejects.toBe(failure);
    });

    it('should delete the object and mark the video as error when it exceeds 10 GiB', async () => {
      storage.headObject.mockResolvedValue({
        contentLength: 10 * 1024 ** 3 + 1,
      });

      await expect(
        service.completeUpload(USER_ID, 'AbCdEfGh_-1', { parts }),
      ).rejects.toBeInstanceOf(FileTooLargeException);

      expect(storage.deleteObject).toHaveBeenCalledWith(
        'videos/AbCdEfGh_-1/original.mp4',
      );
      expect(videosRepository.transition).toHaveBeenCalledWith(
        'video-uuid',
        VideoStatus.DRAFT,
        VideoStatus.ERROR,
        { error_message: expect.stringMatching(/^FILE_TOO_LARGE: /) as string },
      );
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should accept an object of exactly 10 GiB', async () => {
      storage.headObject.mockResolvedValue({ contentLength: 10 * 1024 ** 3 });

      await expect(
        service.completeUpload(USER_ID, 'AbCdEfGh_-1', { parts }),
      ).resolves.toMatchObject({ status: VideoStatus.PROCESSING });
    });

    it('should delete the object and mark the video as error when it is empty', async () => {
      storage.headObject.mockResolvedValue({ contentLength: 0 });

      await expect(
        service.completeUpload(USER_ID, 'AbCdEfGh_-1', { parts }),
      ).rejects.toBeInstanceOf(EmptyFileException);

      expect(storage.deleteObject).toHaveBeenCalledWith(
        'videos/AbCdEfGh_-1/original.mp4',
      );
      expect(videosRepository.transition).toHaveBeenCalledWith(
        'video-uuid',
        VideoStatus.DRAFT,
        VideoStatus.ERROR,
        { error_message: expect.stringMatching(/^EMPTY_FILE: /) as string },
      );
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should throw VideoNotInDraftException and not enqueue when it loses the transition race', async () => {
      videosRepository.transition.mockResolvedValue(false);

      await expect(
        service.completeUpload(USER_ID, 'AbCdEfGh_-1', { parts }),
      ).rejects.toBeInstanceOf(VideoNotInDraftException);
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should mark the video as error with ENQUEUE_FAILED when publishing fails', async () => {
      producer.enqueue.mockRejectedValue(new Error('redis down'));

      await expect(
        service.completeUpload(USER_ID, 'AbCdEfGh_-1', { parts }),
      ).rejects.toBeInstanceOf(EnqueueFailedException);

      expect(videosRepository.transition).toHaveBeenLastCalledWith(
        'video-uuid',
        VideoStatus.PROCESSING,
        VideoStatus.ERROR,
        { error_message: 'ENQUEUE_FAILED: redis down' },
      );
    });

    it('should reject a part number above the part count before touching the storage', async () => {
      await expect(
        service.completeUpload(USER_ID, 'AbCdEfGh_-1', {
          parts: [{ partNumber: 3, etag: '"x"' }],
        }),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should throw VideoNotFoundException for a video that is not owned', async () => {
      videosRepository.findOwnedByPublicId.mockResolvedValue(null);

      await expect(
        service.completeUpload(USER_ID, 'AbCdEfGh_-1', { parts }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should throw VideoNotInDraftException when completion is repeated', async () => {
      videosRepository.findOwnedByPublicId.mockResolvedValue(
        buildVideo({ status: VideoStatus.PROCESSING, part_count: 2 }),
      );

      await expect(
        service.completeUpload(USER_ID, 'AbCdEfGh_-1', { parts }),
      ).rejects.toBeInstanceOf(VideoNotInDraftException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(producer.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('getOwnedVideo', () => {
    const createdAt = new Date('2026-01-01T10:00:00.000Z');
    const updatedAt = new Date('2026-01-01T10:05:00.000Z');
    const base = {
      title: 'aula',
      original_filename: 'aula.mp4',
      content_type: 'video/mp4',
      created_at: createdAt,
      updated_at: updatedAt,
      size_bytes: null,
      duration_seconds: null,
      metadata: null,
      thumbnail_key: null,
      error_message: null,
    };

    it('should project a draft with null processing fields and no thumbnail', async () => {
      videosRepository.findOwnedByPublicId.mockResolvedValue(
        buildVideo({ ...base, status: VideoStatus.DRAFT }),
      );

      const result = await service.getOwnedVideo(USER_ID, 'AbCdEfGh_-1');

      expect(videosRepository.findOwnedByPublicId).toHaveBeenCalledWith(
        'AbCdEfGh_-1',
        CHANNEL_ID,
      );
      expect(result).toEqual({
        publicId: 'AbCdEfGh_-1',
        title: 'aula',
        status: 'draft',
        originalFilename: 'aula.mp4',
        contentType: 'video/mp4',
        sizeBytes: null,
        durationSeconds: null,
        metadata: null,
        errorMessage: null,
        thumbnailUrl: null,
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-01T10:05:00.000Z',
      });
      expect(storage.presignPublicGetUrl).not.toHaveBeenCalled();
    });

    it('should project a ready video with duration, metadata and a presigned thumbnail', async () => {
      const metadata = {
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        width: 320,
        height: 240,
        video_codec: 'h264',
        audio_codec: 'aac',
        bit_rate: 120000,
        size_bytes: 1000,
      };
      videosRepository.findOwnedByPublicId.mockResolvedValue(
        buildVideo({
          ...base,
          status: VideoStatus.READY,
          size_bytes: 1000,
          duration_seconds: 3,
          metadata,
          thumbnail_key: 'videos/AbCdEfGh_-1/thumbnail.jpg',
        }),
      );
      storage.presignPublicGetUrl.mockResolvedValue('http://storage/thumb');

      const result = await service.getOwnedVideo(USER_ID, 'AbCdEfGh_-1');

      expect(storage.presignPublicGetUrl).toHaveBeenCalledWith(
        'videos/AbCdEfGh_-1/thumbnail.jpg',
        { expiresIn: 3600 },
      );
      expect(result).toMatchObject({
        status: 'ready',
        sizeBytes: 1000,
        durationSeconds: 3,
        metadata,
        thumbnailUrl: 'http://storage/thumb',
      });
    });

    it('should expose the failure reason of a video in error', async () => {
      videosRepository.findOwnedByPublicId.mockResolvedValue(
        buildVideo({
          ...base,
          status: VideoStatus.ERROR,
          error_message: 'INVALID_MEDIA: no video stream',
        }),
      );

      const result = await service.getOwnedVideo(USER_ID, 'AbCdEfGh_-1');

      expect(result.status).toBe('error');
      expect(result.errorMessage).toBe('INVALID_MEDIA: no video stream');
      expect(result.thumbnailUrl).toBeNull();
    });

    it('should not leak internal storage fields', async () => {
      videosRepository.findOwnedByPublicId.mockResolvedValue(
        buildVideo({ ...base, upload_id: 'upload-1' }),
      );

      const result = await service.getOwnedVideo(USER_ID, 'AbCdEfGh_-1');

      expect(result).not.toHaveProperty('storage_key');
      expect(result).not.toHaveProperty('thumbnail_key');
      expect(result).not.toHaveProperty('upload_id');
    });

    it('should throw VideoNotFoundException when the video is unknown or not owned', async () => {
      videosRepository.findOwnedByPublicId.mockResolvedValue(null);

      await expect(
        service.getOwnedVideo(USER_ID, 'AbCdEfGh_-1'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('getStreamUrl / getDownloadUrl', () => {
    const ready = buildVideo({
      status: VideoStatus.READY,
      title: 'Minha aula',
      original_filename: 'aula-original.mp4',
    });

    beforeEach(() => {
      videosRepository.findByPublicId.mockResolvedValue(ready);
      storage.presignPublicGetUrl.mockResolvedValue('http://storage/signed');
    });

    it('should presign the original object for a ready video without ownership scope', async () => {
      const url = await service.getStreamUrl('AbCdEfGh_-1');

      expect(url).toBe('http://storage/signed');
      expect(videosRepository.findByPublicId).toHaveBeenCalledWith(
        'AbCdEfGh_-1',
      );
      expect(storage.presignPublicGetUrl).toHaveBeenCalledWith(
        'videos/AbCdEfGh_-1/original.mp4',
        { expiresIn: 3600 },
      );
    });

    it('should presign the download with an attachment disposition built from the title', async () => {
      const url = await service.getDownloadUrl('AbCdEfGh_-1');

      expect(url).toBe('http://storage/signed');
      expect(storage.presignPublicGetUrl).toHaveBeenCalledWith(
        'videos/AbCdEfGh_-1/original.mp4',
        {
          expiresIn: 3600,
          responseContentDisposition:
            'attachment; filename="Minha aula.mp4"; filename*=UTF-8\'\'Minha%20aula.mp4',
        },
      );
    });

    it('should fall back to the original filename when the title is blank', async () => {
      videosRepository.findByPublicId.mockResolvedValue({
        ...ready,
        title: ' ',
      } as Video);

      await service.getDownloadUrl('AbCdEfGh_-1');

      expect(storage.presignPublicGetUrl).toHaveBeenCalledWith(
        'videos/AbCdEfGh_-1/original.mp4',
        expect.objectContaining({
          responseContentDisposition: expect.stringContaining(
            'filename="aula-original.mp4"',
          ) as string,
        }),
      );
    });

    it.each(['getStreamUrl', 'getDownloadUrl'] as const)(
      '%s should throw VideoNotFoundException for an unknown video',
      async (method) => {
        videosRepository.findByPublicId.mockResolvedValue(null);

        await expect(service[method]('nope')).rejects.toBeInstanceOf(
          VideoNotFoundException,
        );
        expect(storage.presignPublicGetUrl).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['getStreamUrl', VideoStatus.DRAFT],
      ['getStreamUrl', VideoStatus.PROCESSING],
      ['getStreamUrl', VideoStatus.ERROR],
      ['getDownloadUrl', VideoStatus.DRAFT],
      ['getDownloadUrl', VideoStatus.PROCESSING],
      ['getDownloadUrl', VideoStatus.ERROR],
    ] as const)(
      '%s should throw VideoNotReadyException when the video is %s',
      async (method, status) => {
        videosRepository.findByPublicId.mockResolvedValue(
          buildVideo({ status }),
        );

        await expect(service[method]('AbCdEfGh_-1')).rejects.toBeInstanceOf(
          VideoNotReadyException,
        );
        expect(storage.presignPublicGetUrl).not.toHaveBeenCalled();
      },
    );
  });
});
