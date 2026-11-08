import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/video-processing.constants';
import type { ProcessVideoJobData } from '../src/queue/video-processing.types';
import { StorageService } from '../src/storage/storage.service';
import {
  type AuthenticatedTestUser,
  registerConfirmAndLogin,
} from '../src/test/auth-test-helpers';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createMediaFixtures,
  removeMediaFixtures,
  type MediaFixtures,
} from '../src/test/media-fixtures';
import {
  deleteKeys,
  putPartsViaPresignedUrls,
} from '../src/test/storage-test-helpers';
import {
  startTestWorker,
  waitForVideoStatus,
} from '../src/test/worker-test-helpers';
import { VideoStatus } from '../src/videos/video-status.enum';

const MIB = 1024 ** 2;
const PART_SIZE = 64 * MIB;
const PROCESSING_TIMEOUT_MS = 60_000;

interface DraftResponse {
  publicId: string;
  partCount: number;
}

interface VideoResponse {
  status: string;
  sizeBytes: number | null;
  durationSeconds: number | null;
  metadata: Record<string, unknown> | null;
  errorMessage: string | null;
  thumbnailUrl: string | null;
}

describe('Video pipeline (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue<ProcessVideoJobData>;
  let user: AuthenticatedTestUser;
  let fixtures: MediaFixtures;
  let worker: TestingModule | undefined;
  const queuePrefix = `test-video-pipeline-${randomUUID()}`;
  const originalQueuePrefix = process.env.QUEUE_PREFIX;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = queuePrefix;
    fixtures = await createMediaFixtures();
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storage = moduleFixture.get(StorageService);
    queue = moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 120_000);

  afterAll(async () => {
    await worker?.close();
    await deleteKeys(storage, createdKeys);
    await queue.obliterate({ force: true });
    await app.close();
    await removeMediaFixtures(fixtures);
    if (originalQueuePrefix === undefined) {
      delete process.env.QUEUE_PREFIX;
    } else {
      process.env.QUEUE_PREFIX = originalQueuePrefix;
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    throttlerStorage.storage.clear();
    user = await registerConfirmAndLogin(app, dataSource);
  });

  // The global ThrottlerGuard (10 req/min per IP) also covers /videos*: reset it before every call.
  function http(): ReturnType<typeof request> {
    throttlerStorage.storage.clear();
    return request(app.getHttpServer());
  }

  function authorized(test: request.Test): request.Test {
    return test.set('Authorization', `Bearer ${user.access_token}`);
  }

  async function ensureWorker(): Promise<void> {
    worker ??= await startTestWorker(queuePrefix);
  }

  // The declared size only plans the parts: (N - 1) * 64 MiB + 1 plans N parts.
  function declaredSizeFor(partCount: number, actualSize: number): number {
    return partCount === 1 ? actualSize : (partCount - 1) * PART_SIZE + 1;
  }

  async function uploadVideo(
    file: Buffer,
    options: { title: string; contentType?: string; partSizes?: number[] },
  ): Promise<string> {
    const contentType = options.contentType ?? 'video/mp4';
    const partSizes = options.partSizes ?? [file.length];
    const created = await authorized(http().post('/videos'))
      .send({
        filename: 'upload.mp4',
        contentType,
        sizeBytes: declaredSizeFor(partSizes.length, file.length),
        title: options.title,
      })
      .expect(201);
    const draft = created.body as DraftResponse;
    expect(draft.partCount).toBe(partSizes.length);
    createdKeys.push(
      `videos/${draft.publicId}/original.mp4`,
      `videos/${draft.publicId}/thumbnail.jpg`,
    );

    const partNumbers = partSizes.map((_size, index) => index + 1);
    const partUrls = await authorized(
      http().post(`/videos/${draft.publicId}/upload/part-urls`),
    )
      .send({ partNumbers })
      .expect(200);
    const { urls } = partUrls.body as {
      urls: { partNumber: number; url: string }[];
    };

    const bodies = new Map<number, Buffer>();
    let offset = 0;
    partSizes.forEach((size, index) => {
      const end = index === partSizes.length - 1 ? file.length : offset + size;
      bodies.set(index + 1, file.subarray(offset, end));
      offset = end;
    });
    const parts = await putPartsViaPresignedUrls(urls, bodies);

    await authorized(http().post(`/videos/${draft.publicId}/upload/completion`))
      .send({ parts })
      .expect(202);
    return draft.publicId;
  }

  async function getVideo(publicId: string): Promise<VideoResponse> {
    const response = await authorized(http().get(`/videos/${publicId}`)).expect(
      200,
    );
    return response.body as VideoResponse;
  }

  it('should take a multipart upload through the worker to a streamable, downloadable video', async () => {
    const file = await readFile(fixtures.mp4Large);

    const publicId = await uploadVideo(file, {
      title: 'Pipeline test',
      partSizes: [5 * MIB, 5 * MIB, file.length - 10 * MIB],
    });

    // Before the worker runs: the video is processing and not yet deliverable.
    const processing = await getVideo(publicId);
    expect(processing.status).toBe('processing');
    expect(processing.sizeBytes).toBe(file.length);
    expect(processing.durationSeconds).toBeNull();
    const notReady = await http().get(`/videos/${publicId}/stream`).expect(409);
    expect(notReady.body).toMatchObject({ error: 'VIDEO_NOT_READY' });

    await ensureWorker();
    await waitForVideoStatus(
      dataSource,
      publicId,
      VideoStatus.READY,
      PROCESSING_TIMEOUT_MS,
    );

    const ready = await getVideo(publicId);
    expect(ready.status).toBe('ready');
    expect(ready.durationSeconds).toBeGreaterThan(4);
    expect(ready.metadata).toMatchObject({
      video_codec: 'h264',
      width: 640,
      height: 480,
    });
    const thumbnail = await fetch(ready.thumbnailUrl!);
    expect(thumbnail.status).toBe(200);
    const thumbnailBytes = Buffer.from(await thumbnail.arrayBuffer());
    expect(thumbnailBytes.subarray(0, 3)).toEqual(
      Buffer.from([0xff, 0xd8, 0xff]),
    );

    const stream = await http().get(`/videos/${publicId}/stream`).expect(302);
    const streamLocation = stream.headers.location;
    expect(streamLocation.startsWith(process.env.S3_PUBLIC_ENDPOINT!)).toBe(
      true,
    );
    const partial = await fetch(streamLocation, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(
      `bytes 0-99/${file.length}`,
    );
    const partialBytes = Buffer.from(await partial.arrayBuffer());
    expect(partialBytes).toHaveLength(100);
    expect(partialBytes.equals(file.subarray(0, 100))).toBe(true);

    const download = await http()
      .get(`/videos/${publicId}/download`)
      .expect(302);
    const downloaded = await fetch(download.headers.location);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-disposition')).toMatch(
      /^attachment; filename="Pipeline test\.mp4"/,
    );
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(file)).toBe(true);
  }, 180_000);

  it('should mark a text file uploaded as video/mp4 as error with INVALID_MEDIA and keep it undeliverable', async () => {
    const file = await readFile(fixtures.text);
    await ensureWorker();

    const publicId = await uploadVideo(file, { title: 'Not a video' });
    await waitForVideoStatus(
      dataSource,
      publicId,
      VideoStatus.ERROR,
      PROCESSING_TIMEOUT_MS,
    );

    const failed = await getVideo(publicId);
    expect(failed.status).toBe('error');
    expect(failed.errorMessage).toMatch(/^INVALID_MEDIA/);
    expect(failed.thumbnailUrl).toBeNull();
    const stream = await http().get(`/videos/${publicId}/stream`).expect(409);
    expect(stream.body).toMatchObject({ error: 'VIDEO_NOT_READY' });
  }, 120_000);

  it('should give videos created in sequence distinct public ids and stream URLs', async () => {
    const file = await readFile(fixtures.mp4);
    await ensureWorker();

    const first = await uploadVideo(file, { title: 'First' });
    const second = await uploadVideo(file, { title: 'Second' });
    await waitForVideoStatus(
      dataSource,
      first,
      VideoStatus.READY,
      PROCESSING_TIMEOUT_MS,
    );
    await waitForVideoStatus(
      dataSource,
      second,
      VideoStatus.READY,
      PROCESSING_TIMEOUT_MS,
    );

    const firstStream = await http().get(`/videos/${first}/stream`).expect(302);
    const secondStream = await http()
      .get(`/videos/${second}/stream`)
      .expect(302);

    expect(first).not.toBe(second);
    expect(firstStream.headers.location).not.toBe(
      secondStream.headers.location,
    );
  }, 120_000);
});
