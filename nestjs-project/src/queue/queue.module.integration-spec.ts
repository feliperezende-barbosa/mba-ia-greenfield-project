import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { QueueModule } from './queue.module';
import {
  PROCESS_VIDEO_ATTEMPTS,
  PROCESS_VIDEO_BACKOFF_DELAY_MS,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

describe('QueueModule (integration)', () => {
  const originalPrefix = process.env.QUEUE_PREFIX;
  const prefixA = `test-module-a-${randomUUID()}`;
  const prefixB = `test-module-b-${randomUUID()}`;
  const modules: TestingModule[] = [];

  async function compileWithPrefix(prefix: string): Promise<TestingModule> {
    process.env.QUEUE_PREFIX = prefix;
    const module = await Test.createTestingModule({
      imports: [QueueModule],
    }).compile();
    await module.init();
    modules.push(module);
    return module;
  }

  afterAll(async () => {
    for (const module of modules) {
      await module
        .get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE))
        .obliterate({ force: true });
      await module.close();
    }
    if (originalPrefix === undefined) {
      delete process.env.QUEUE_PREFIX;
    } else {
      process.env.QUEUE_PREFIX = originalPrefix;
    }
  });

  it('should compile against the Compose Redis and resolve the queue by token', async () => {
    const module = await compileWithPrefix(prefixA);

    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
    expect(module.get(VideoProcessingProducer)).toBeInstanceOf(
      VideoProcessingProducer,
    );
    await expect(queue.getJobCounts()).resolves.toBeDefined();
  });

  it('should apply the configured prefix and the default job options', async () => {
    const module = await compileWithPrefix(prefixA);
    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    expect(queue.opts.prefix).toBe(prefixA);
    expect(queue.opts.defaultJobOptions).toEqual({
      attempts: PROCESS_VIDEO_ATTEMPTS,
      backoff: { type: 'exponential', delay: PROCESS_VIDEO_BACKOFF_DELAY_MS },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  });

  it('should isolate jobs between suites using different prefixes', async () => {
    const moduleA = await compileWithPrefix(prefixA);
    const moduleB = await compileWithPrefix(prefixB);
    const videoId = randomUUID();

    await moduleA
      .get(VideoProcessingProducer)
      .enqueue({ id: videoId, public_id: 'AbCdEfGh_-1' });

    const queueA = moduleA.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    const queueB = moduleB.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(await queueA.getJob(videoId)).toBeDefined();
    expect(await queueB.getJob(videoId)).toBeUndefined();
  });
});
