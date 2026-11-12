import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UnrecoverableError, type Job } from 'bullmq';
import { InvalidMediaError } from '../media/media.errors';
import { MediaService } from '../media/media.service';
import { StorageService } from '../storage/storage.service';
import type { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/video-status.enum';
import { VideosRepository } from '../videos/videos.repository';
import { VideoProcessingService } from './video-processing.service';

const VIDEO_ID = '7c1b6d0e-4a55-4a43-9a1b-0d3f2a9e6b10';
const PUBLIC_ID = 'AbCdEfGh_-1';
const SOURCE_URL = 'http://minio:9000/streamtube/videos/x/original.mp4?sig=1';

function buildVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: VIDEO_ID,
    public_id: PUBLIC_ID,
    status: VideoStatus.PROCESSING,
    storage_key: `videos/${PUBLIC_ID}/original.mp4`,
    ...overrides,
  } as Video;
}

function buildJob(overrides: Record<string, unknown> = {}): Job {
  return {
    id: VIDEO_ID,
    name: 'process-video',
    data: { videoId: VIDEO_ID, publicId: PUBLIC_ID },
    attemptsMade: 1,
    opts: { attempts: 3 },
    ...overrides,
  } as unknown as Job;
}

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  let videos: { findById: jest.Mock; transition: jest.Mock };
  let storage: { presignInternalGetUrl: jest.Mock; putObject: jest.Mock };
  let media: { probe: jest.Mock; generateThumbnail: jest.Mock };

  const probeResult = {
    durationSeconds: 3.04,
    metadata: {
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
      bit_rate: 1000,
      size_bytes: 2000,
    },
  };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  beforeEach(async () => {
    videos = {
      findById: jest.fn().mockResolvedValue(buildVideo()),
      transition: jest.fn().mockResolvedValue(true),
    };
    storage = {
      presignInternalGetUrl: jest.fn().mockResolvedValue(SOURCE_URL),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    media = {
      probe: jest.fn().mockResolvedValue(probeResult),
      generateThumbnail: jest.fn().mockResolvedValue(jpeg),
    };
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: VideosRepository, useValue: videos },
        { provide: StorageService, useValue: storage },
        { provide: MediaService, useValue: media },
      ],
    }).compile();
    service = module.get(VideoProcessingService);
  });

  describe('process', () => {
    it('should store the thumbnail and move the video to ready with the extracted data', async () => {
      await service.process(VIDEO_ID);

      expect(storage.presignInternalGetUrl).toHaveBeenCalledWith(
        `videos/${PUBLIC_ID}/original.mp4`,
        expect.any(Number),
      );
      expect(media.probe).toHaveBeenCalledWith(SOURCE_URL);
      expect(media.generateThumbnail).toHaveBeenCalledWith(SOURCE_URL, 3.04);
      expect(storage.putObject).toHaveBeenCalledWith(
        `videos/${PUBLIC_ID}/thumbnail.jpg`,
        jpeg,
        'image/jpeg',
      );
      expect(videos.transition).toHaveBeenCalledWith(
        VIDEO_ID,
        VideoStatus.PROCESSING,
        VideoStatus.READY,
        {
          duration_seconds: 3.04,
          metadata: probeResult.metadata,
          thumbnail_key: `videos/${PUBLIC_ID}/thumbnail.jpg`,
        },
      );
    });

    it.each([VideoStatus.DRAFT, VideoStatus.READY, VideoStatus.ERROR])(
      'should be a no-op when the video is %s',
      async (status) => {
        videos.findById.mockResolvedValue(buildVideo({ status }));

        await service.process(VIDEO_ID);

        expect(media.probe).not.toHaveBeenCalled();
        expect(storage.putObject).not.toHaveBeenCalled();
        expect(videos.transition).not.toHaveBeenCalled();
      },
    );

    it('should throw UnrecoverableError when the video does not exist', async () => {
      videos.findById.mockResolvedValue(null);

      await expect(service.process(VIDEO_ID)).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(media.probe).not.toHaveBeenCalled();
    });

    it('should convert InvalidMediaError from the probe into an INVALID_MEDIA UnrecoverableError', async () => {
      media.probe.mockRejectedValue(new InvalidMediaError('no video stream'));

      const error: unknown = await service
        .process(VIDEO_ID)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect((error as Error).message).toBe('INVALID_MEDIA: no video stream');
      expect(storage.putObject).not.toHaveBeenCalled();
      expect(videos.transition).not.toHaveBeenCalled();
    });

    it('should convert InvalidMediaError from the thumbnail into an UnrecoverableError', async () => {
      media.generateThumbnail.mockRejectedValue(
        new InvalidMediaError('no frame could be extracted'),
      );

      await expect(service.process(VIDEO_ID)).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
    });

    it('should propagate retriable errors untouched', async () => {
      const failure = new Error('ffprobe failed: Server returned 404');
      media.probe.mockRejectedValue(failure);

      const error: unknown = await service
        .process(VIDEO_ID)
        .catch((e: unknown) => e);

      expect(error).toBe(failure);
      expect(error).not.toBeInstanceOf(UnrecoverableError);
      expect(videos.transition).not.toHaveBeenCalled();
    });
  });

  describe('handleFailure', () => {
    it('should mark the video as error on the first attempt when the error is unrecoverable', async () => {
      const job = buildJob({ attemptsMade: 1 });

      await service.handleFailure(
        job,
        new UnrecoverableError('INVALID_MEDIA: no video stream'),
      );

      expect(videos.transition).toHaveBeenCalledWith(
        VIDEO_ID,
        VideoStatus.PROCESSING,
        VideoStatus.ERROR,
        { error_message: 'INVALID_MEDIA: no video stream' },
      );
    });

    it('should recognise an unrecoverable error by its name', async () => {
      const error = Object.assign(new Error('boom'), {
        name: 'UnrecoverableError',
      });

      await service.handleFailure(buildJob({ attemptsMade: 1 }), error);

      expect(videos.transition).toHaveBeenCalledWith(
        VIDEO_ID,
        VideoStatus.PROCESSING,
        VideoStatus.ERROR,
        { error_message: 'PROCESSING_FAILED: boom' },
      );
    });

    it.each([1, 2])(
      'should keep the video processing on retriable attempt %p of 3',
      async (attemptsMade) => {
        await service.handleFailure(
          buildJob({ attemptsMade }),
          new Error('storage unavailable'),
        );

        expect(videos.transition).not.toHaveBeenCalled();
      },
    );

    it('should mark the video as error with PROCESSING_FAILED when the last attempt fails', async () => {
      await service.handleFailure(
        buildJob({ attemptsMade: 3 }),
        new Error('storage unavailable'),
      );

      expect(videos.transition).toHaveBeenCalledWith(
        VIDEO_ID,
        VideoStatus.PROCESSING,
        VideoStatus.ERROR,
        { error_message: 'PROCESSING_FAILED: storage unavailable' },
      );
    });

    it('should treat a job without attempts option as exhausted', async () => {
      await service.handleFailure(
        buildJob({ attemptsMade: 1, opts: {} }),
        new Error('boom'),
      );

      expect(videos.transition).toHaveBeenCalledTimes(1);
    });

    it('should ignore an undefined job', async () => {
      await service.handleFailure(undefined, new Error('boom'));

      expect(videos.transition).not.toHaveBeenCalled();
    });

    it('should ignore jobs with another name', async () => {
      await service.handleFailure(
        buildJob({ name: 'other-job', attemptsMade: 3 }),
        new Error('boom'),
      );

      expect(videos.transition).not.toHaveBeenCalled();
    });

    it('should log and not rethrow when persisting the error status fails', async () => {
      videos.transition.mockRejectedValue(new Error('db down'));
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();

      await expect(
        service.handleFailure(buildJob({ attemptsMade: 3 }), new Error('boom')),
      ).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledTimes(1);
      logged.mockRestore();
    });
  });
});
