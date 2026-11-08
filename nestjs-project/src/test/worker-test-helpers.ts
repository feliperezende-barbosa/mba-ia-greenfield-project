import { Test, type TestingModule } from '@nestjs/testing';
import type { DataSource } from 'typeorm';
import { VideoWorkerModule } from '../video-worker/video-worker.module';
import { Video } from '../videos/entities/video.entity';
import type { VideoStatus } from '../videos/video-status.enum';
import { waitFor } from './wait-for';

// The returned context is the consumer: the processor starts the BullMQ worker on init.
// The caller owns the context and must close it.
export async function startTestWorker(
  queuePrefix: string,
): Promise<TestingModule> {
  process.env.QUEUE_PREFIX = queuePrefix;
  const module = await Test.createTestingModule({
    imports: [VideoWorkerModule],
  }).compile();
  await module.init();
  return module;
}

export async function waitForVideoStatus(
  dataSource: DataSource,
  publicId: string,
  status: VideoStatus,
  timeoutMs: number,
): Promise<Video> {
  return waitFor(
    async () => {
      const video = await dataSource
        .getRepository(Video)
        .findOneBy({ public_id: publicId });
      return video?.status === status ? video : null;
    },
    { timeoutMs, description: `video ${publicId} to reach status ${status}` },
  );
}
