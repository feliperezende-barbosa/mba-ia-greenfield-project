import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { QueueModule } from './queue.module';
import {
  PROCESS_VIDEO_ATTEMPTS,
  PROCESS_VIDEO_BACKOFF_DELAY_MS,
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';
import type { ProcessVideoJobData } from './video-processing.types';

describe('VideoProcessingProducer (integration)', () => {
  const originalPrefix = process.env.QUEUE_PREFIX;
  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue<ProcessVideoJobData>;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `test-producer-${randomUUID()}`;
    module = await Test.createTestingModule({
      imports: [QueueModule],
    }).compile();
    await module.init();
    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
    if (originalPrefix === undefined) {
      delete process.env.QUEUE_PREFIX;
    } else {
      process.env.QUEUE_PREFIX = originalPrefix;
    }
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it('should publish a waiting job with name, payload, jobId and retry options', async () => {
    const video = { id: randomUUID(), public_id: 'AbCdEfGh_-1' };

    await producer.enqueue(video);

    const job = await queue.getJob(video.id);
    expect(job).toBeDefined();
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.id).toBe(video.id);
    expect(job!.data).toEqual({ videoId: video.id, publicId: video.public_id });
    expect(await job!.getState()).toBe('waiting');
    expect(job!.opts.attempts).toBe(PROCESS_VIDEO_ATTEMPTS);
    expect(job!.opts.backoff).toEqual({
      type: 'exponential',
      delay: PROCESS_VIDEO_BACKOFF_DELAY_MS,
    });
  });

  it('should keep a single job when the same video is published twice', async () => {
    const video = { id: randomUUID(), public_id: 'AbCdEfGh_-1' };

    await producer.enqueue(video);
    await producer.enqueue(video);

    const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
    expect(counts.waiting).toBe(1);
    expect(counts.active + counts.delayed).toBe(0);
  });

  it('should reject when Redis is unreachable', async () => {
    const original = {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
    };
    // BullMQ logs every refused connection attempt through console.error.
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    process.env.REDIS_HOST = 'redis';
    process.env.REDIS_PORT = '6399';
    const unreachable = await Test.createTestingModule({
      imports: [QueueModule],
    }).compile();

    try {
      await expect(
        unreachable
          .get(VideoProcessingProducer)
          .enqueue({ id: randomUUID(), public_id: 'AbCdEfGh_-1' }),
      ).rejects.toThrow();
    } finally {
      await unreachable.close();
      consoleError.mockRestore();
      process.env.REDIS_HOST = original.host;
      process.env.REDIS_PORT = original.port;
    }
  }, 20_000);
});
