import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import {
  ENQUEUE_TIMEOUT_MS,
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer', () => {
  let producer: VideoProcessingProducer;
  let queue: { add: jest.Mock };

  const video = {
    id: '6f1b3a1e-8f0a-4f5e-9d6c-0c2f1f4b7a10',
    public_id: 'AbCdEfGh_-1',
  };

  beforeEach(async () => {
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProducer,
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
      ],
    }).compile();
    producer = module.get(VideoProcessingProducer);
  });

  it('should add the process-video job with the payload and the video uuid as jobId', async () => {
    await producer.enqueue(video);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      PROCESS_VIDEO_JOB,
      { videoId: video.id, publicId: video.public_id },
      { jobId: video.id },
    );
  });

  it('should propagate a rejection from the queue', async () => {
    queue.add.mockRejectedValueOnce(new Error('Redis is down'));

    await expect(producer.enqueue(video)).rejects.toThrow('Redis is down');
  });

  it('should reject instead of waiting forever when the queue never answers', async () => {
    jest.useFakeTimers();
    try {
      queue.add.mockReturnValueOnce(new Promise(() => undefined));

      const publishing = producer.enqueue(video);
      const assertion = expect(publishing).rejects.toThrow('timed out');
      await jest.advanceTimersByTimeAsync(ENQUEUE_TIMEOUT_MS);

      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });
});
