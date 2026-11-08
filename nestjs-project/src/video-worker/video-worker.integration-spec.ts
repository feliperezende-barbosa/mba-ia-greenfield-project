import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DataSource } from 'typeorm';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/video-processing.constants';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import type { ProcessVideoJobData } from '../queue/video-processing.types';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import {
  createMediaFixtures,
  removeMediaFixtures,
  type MediaFixtures,
} from '../test/media-fixtures';
import { deleteKeys } from '../test/storage-test-helpers';
import { waitFor } from '../test/wait-for';
import { buildDraftInput, createTestChannel } from '../test/video-test-data';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/video-status.enum';
import { VideosRepository } from '../videos/videos.repository';
import { VideoWorkerModule } from './video-worker.module';

describe('VideoWorkerModule (integration)', () => {
  const originalPrefix = process.env.QUEUE_PREFIX;
  let module: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let producer: VideoProcessingProducer;
  let queue: Queue<ProcessVideoJobData>;
  let fixtures: MediaFixtures;
  const createdKeys: string[] = [];

  async function createProcessingVideo(sourcePath: string): Promise<Video> {
    const channel = await createTestChannel(dataSource);
    const draft = await module
      .get(VideosRepository)
      .createDraft(buildDraftInput(channel.id));
    createdKeys.push(
      draft.storage_key,
      `videos/${draft.public_id}/thumbnail.jpg`,
    );
    await storage.putObject(
      draft.storage_key,
      await readFile(sourcePath),
      draft.content_type,
    );
    await dataSource
      .getRepository(Video)
      .update({ id: draft.id }, { status: VideoStatus.PROCESSING });
    return dataSource.getRepository(Video).findOneByOrFail({ id: draft.id });
  }

  function reload(video: Video): Promise<Video> {
    return dataSource.getRepository(Video).findOneByOrFail({ id: video.id });
  }

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `test-video-worker-${randomUUID()}`;
    fixtures = await createMediaFixtures();

    // The context is also the consumer: the processor starts the BullMQ worker on init.
    module = await Test.createTestingModule({
      imports: [VideoWorkerModule],
    }).compile();
    await module.init();

    dataSource = module.get(DataSource);
    storage = module.get(StorageService);
    producer = module.get(VideoProcessingProducer, { strict: false });
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE), {
      strict: false,
    });
  }, 60_000);

  afterAll(async () => {
    await deleteKeys(storage, createdKeys);
    await queue.obliterate({ force: true });
    await module.close();
    await removeMediaFixtures(fixtures);
    if (originalPrefix === undefined) {
      delete process.env.QUEUE_PREFIX;
    } else {
      process.env.QUEUE_PREFIX = originalPrefix;
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  it('should consume the job published by the producer and move the video to ready', async () => {
    const video = await createProcessingVideo(fixtures.mp4);

    await producer.enqueue(video);

    const ready = await waitFor(
      async () => {
        const current = await reload(video);
        return current.status === VideoStatus.READY ? current : null;
      },
      { description: 'video to become ready' },
    );
    expect(ready.duration_seconds).toBeGreaterThan(0);
    expect(ready.metadata?.video_codec).toBe('h264');
    expect(ready.thumbnail_key).toBe(`videos/${video.public_id}/thumbnail.jpg`);
    expect(await storage.headObject(ready.thumbnail_key!)).not.toBeNull();
  });

  it('should fail invalid media on the first attempt without retrying', async () => {
    const video = await createProcessingVideo(fixtures.text);

    await producer.enqueue(video);

    const failed = await waitFor(
      async () => {
        const current = await reload(video);
        return current.status === VideoStatus.ERROR ? current : null;
      },
      { description: 'video to become error' },
    );
    expect(failed.error_message).toMatch(/^INVALID_MEDIA:/);
    const job = await queue.getJob(video.id);
    expect(job?.attemptsMade).toBe(1);
    expect(await job?.getState()).toBe('failed');
  });

  it('should keep the video processing between retriable attempts and then mark it error', async () => {
    const video = await createProcessingVideo(fixtures.mp4);
    await storage.deleteObject(video.storage_key);

    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId: video.id, publicId: video.public_id },
      {
        jobId: video.id,
        attempts: 2,
        backoff: { type: 'fixed', delay: 1500 },
      },
    );

    await waitFor(
      async () => {
        const job = await queue.getJob(video.id);
        return job?.attemptsMade === 1 && (await job.getState()) === 'delayed';
      },
      { description: 'first attempt to fail and the retry to be scheduled' },
    );
    expect((await reload(video)).status).toBe(VideoStatus.PROCESSING);

    const failed = await waitFor(
      async () => {
        const current = await reload(video);
        return current.status === VideoStatus.ERROR ? current : null;
      },
      { description: 'video to become error after the last attempt' },
    );
    expect(failed.error_message).toMatch(/^PROCESSING_FAILED:/);
    expect((await queue.getJob(video.id))?.attemptsMade).toBe(2);
  });
});
