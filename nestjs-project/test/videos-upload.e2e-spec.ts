import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/video-status.enum';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  type AuthenticatedTestUser,
  registerConfirmAndLogin,
} from '../src/test/auth-test-helpers';
import {
  deleteKeys,
  putPartsViaPresignedUrls,
} from '../src/test/storage-test-helpers';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/video-processing.constants';
import { VideoProcessingProducer } from '../src/queue/video-processing.producer';
import type { ProcessVideoJobData } from '../src/queue/video-processing.types';
import { StorageService } from '../src/storage/storage.service';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let user: AuthenticatedTestUser;
  let queue: Queue<ProcessVideoJobData>;
  const originalQueuePrefix = process.env.QUEUE_PREFIX;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `test-videos-upload-${randomUUID()}`;
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
  });

  afterAll(async () => {
    await deleteKeys(storage, createdKeys);
    await queue.obliterate({ force: true });
    await app.close();
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
    throttlerStorage.storage.clear();
  });

  function authorized(test: request.Test): request.Test {
    return test.set('Authorization', `Bearer ${user.access_token}`);
  }

  describe('POST /videos', () => {
    const body = {
      filename: 'aula.mp4',
      contentType: 'video/mp4',
      sizeBytes: 150 * MIB,
    };

    it('should create the draft and return the upload plan', async () => {
      const response = await authorized(
        request(app.getHttpServer()).post('/videos'),
      )
        .send(body)
        .expect(201);

      const result = response.body as { publicId: string };
      createdKeys.push(`videos/${result.publicId}/original.mp4`);
      expect(result.publicId).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(response.body).toEqual({
        publicId: result.publicId,
        status: 'draft',
        title: 'aula',
        partSize: 64 * MIB,
        partCount: 3,
      });
      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: result.publicId });
      expect(row.storage_key).toBe(`videos/${result.publicId}/original.mp4`);
      expect(row.upload_id).toEqual(expect.any(String));
      expect(row.channel_id).toEqual(expect.any(String));
    });

    it('should persist the informed title', async () => {
      const response = await authorized(
        request(app.getHttpServer()).post('/videos'),
      )
        .send({ ...body, title: 'Minha aula' })
        .expect(201);

      const result = response.body as { publicId: string; title: string };
      createdKeys.push(`videos/${result.publicId}/original.mp4`);
      expect(result.title).toBe('Minha aula');
    });

    it('should return distinct public ids for consecutive requests', async () => {
      const first = await authorized(
        request(app.getHttpServer()).post('/videos'),
      )
        .send(body)
        .expect(201);
      const second = await authorized(
        request(app.getHttpServer()).post('/videos'),
      )
        .send(body)
        .expect(201);

      const ids = [first, second].map(
        (response) => (response.body as { publicId: string }).publicId,
      );
      createdKeys.push(...ids.map((id) => `videos/${id}/original.mp4`));
      expect(ids[0]).not.toBe(ids[1]);
    });

    it.each([
      [
        'content type outside the allow-list',
        { contentType: 'application/pdf' },
      ],
      ['zero size', { sizeBytes: 0 }],
      ['size above 10 GiB', { sizeBytes: 10 * GIB + 1 }],
    ])('should reject %s with VALIDATION_ERROR', async (_label, override) => {
      const response = await authorized(
        request(app.getHttpServer()).post('/videos'),
      )
        .send({ ...body, ...override })
        .expect(400);

      expect(response.body).toMatchObject({
        statusCode: 400,
        error: 'VALIDATION_ERROR',
      });
      expect(await dataSource.getRepository(Video).count()).toBe(0);
    });

    it('should reject a request without token', async () => {
      await request(app.getHttpServer()).post('/videos').send(body).expect(401);
    });

    it('should answer 404 CHANNEL_NOT_FOUND when the user has no channel', async () => {
      await dataSource.query('DELETE FROM "channels"');

      const response = await authorized(
        request(app.getHttpServer()).post('/videos'),
      )
        .send(body)
        .expect(404);

      expect(response.body).toMatchObject({ error: 'CHANNEL_NOT_FOUND' });
    });
  });

  async function createDraft(sizeBytes = 150 * MIB): Promise<string> {
    const response = await authorized(
      request(app.getHttpServer()).post('/videos'),
    )
      .send({ filename: 'aula.mp4', contentType: 'video/mp4', sizeBytes })
      .expect(201);
    const { publicId } = response.body as { publicId: string };
    createdKeys.push(`videos/${publicId}/original.mp4`);
    return publicId;
  }

  describe('POST /videos/:publicId/upload/part-urls', () => {
    it('should return presigned URLs that accept part bytes and expose the ETag', async () => {
      const publicId = await createDraft();

      const response = await authorized(
        request(app.getHttpServer()).post(
          `/videos/${publicId}/upload/part-urls`,
        ),
      )
        .send({ partNumbers: [1, 2] })
        .expect(200);

      const body = response.body as {
        expiresInSeconds: number;
        urls: { partNumber: number; url: string }[];
      };
      expect(body.expiresInSeconds).toBe(3600);
      expect(body.urls.map((entry) => entry.partNumber)).toEqual([1, 2]);
      const put = await fetch(body.urls[0].url, {
        method: 'PUT',
        body: new Blob([new Uint8Array(1024)]),
      });
      expect(put.ok).toBe(true);
      expect(put.headers.get('etag')).toBeTruthy();
    });

    it('should reject a part number above the part count', async () => {
      const publicId = await createDraft();

      const response = await authorized(
        request(app.getHttpServer()).post(
          `/videos/${publicId}/upload/part-urls`,
        ),
      )
        .send({ partNumbers: [4] })
        .expect(400);

      expect(response.body).toMatchObject({ error: 'INVALID_PART_NUMBER' });
    });

    it.each([
      ['empty list', []],
      ['duplicates', [1, 1]],
      ['part zero', [0]],
    ])(
      'should reject %s with VALIDATION_ERROR',
      async (_label, partNumbers) => {
        const publicId = await createDraft();

        const response = await authorized(
          request(app.getHttpServer()).post(
            `/videos/${publicId}/upload/part-urls`,
          ),
        )
          .send({ partNumbers })
          .expect(400);

        expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
      },
    );

    it('should answer the same 404 for an unknown video and for a video of another channel', async () => {
      const publicId = await createDraft();
      const stranger = await registerConfirmAndLogin(app, dataSource);

      const unknown = await authorized(
        request(app.getHttpServer()).post(
          '/videos/doesnotexist/upload/part-urls',
        ),
      )
        .send({ partNumbers: [1] })
        .expect(404);
      const foreign = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/part-urls`)
        .set('Authorization', `Bearer ${stranger.access_token}`)
        .send({ partNumbers: [1] })
        .expect(404);

      expect(unknown.body).toEqual(foreign.body);
      expect(foreign.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    });

    it('should answer 409 VIDEO_NOT_IN_DRAFT when the video left draft', async () => {
      const publicId = await createDraft();
      await dataSource
        .getRepository(Video)
        .update({ public_id: publicId }, { status: VideoStatus.PROCESSING });

      const response = await authorized(
        request(app.getHttpServer()).post(
          `/videos/${publicId}/upload/part-urls`,
        ),
      )
        .send({ partNumbers: [1] })
        .expect(409);

      expect(response.body).toMatchObject({ error: 'VIDEO_NOT_IN_DRAFT' });
    });

    it('should reject a request without token', async () => {
      await request(app.getHttpServer())
        .post('/videos/AbCdEfGh_-1/upload/part-urls')
        .send({ partNumbers: [1] })
        .expect(401);
    });
  });

  describe('POST /videos/:publicId/upload/completion', () => {
    async function uploadTwoParts(
      publicId: string,
    ): Promise<{ partNumber: number; etag: string }[]> {
      const response = await authorized(
        request(app.getHttpServer()).post(
          `/videos/${publicId}/upload/part-urls`,
        ),
      )
        .send({ partNumbers: [1, 2] })
        .expect(200);
      const { urls } = response.body as {
        urls: { partNumber: number; url: string }[];
      };
      return putPartsViaPresignedUrls(
        urls,
        new Map([
          [1, Buffer.alloc(5 * MIB, 1)],
          [2, Buffer.alloc(MIB, 2)],
        ]),
      );
    }

    function complete(publicId: string, body: object): request.Test {
      return authorized(
        request(app.getHttpServer()).post(
          `/videos/${publicId}/upload/completion`,
        ),
      ).send(body);
    }

    // 64 MiB + 1 byte plans exactly 2 parts; the real parts are smaller.
    const twoPartSize = 64 * MIB + 1;

    it('should answer 202, move the video to processing and publish the job', async () => {
      const publicId = await createDraft(twoPartSize);
      const parts = await uploadTwoParts(publicId);

      const response = await complete(publicId, { parts }).expect(202);

      expect(response.body).toEqual({ publicId, status: 'processing' });
      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: publicId });
      expect(row.status).toBe(VideoStatus.PROCESSING);
      expect(row.size_bytes).toBe(6 * MIB);
      expect(await queue.getJob(row.id)).toBeDefined();
    });

    it('should answer 409 VIDEO_NOT_IN_DRAFT when the completion is repeated', async () => {
      const publicId = await createDraft(twoPartSize);
      const parts = await uploadTwoParts(publicId);
      await complete(publicId, { parts }).expect(202);

      const response = await complete(publicId, { parts }).expect(409);

      expect(response.body).toMatchObject({ error: 'VIDEO_NOT_IN_DRAFT' });
      const counts = await queue.getJobCounts('waiting');
      expect(counts.waiting).toBe(1);
    });

    it('should answer 422 UPLOAD_COMPLETION_FAILED for an invalid ETag and keep the draft', async () => {
      const publicId = await createDraft(twoPartSize);
      const parts = await uploadTwoParts(publicId);

      const response = await complete(publicId, {
        parts: [parts[0], { partNumber: 2, etag: '"deadbeef"' }],
      }).expect(422);

      expect(response.body).toMatchObject({
        error: 'UPLOAD_COMPLETION_FAILED',
      });
      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: publicId });
      expect(row.status).toBe(VideoStatus.DRAFT);
    });

    it('should answer 422 EMPTY_FILE and mark the video as error', async () => {
      const publicId = await createDraft(MIB);
      const urlsResponse = await authorized(
        request(app.getHttpServer()).post(
          `/videos/${publicId}/upload/part-urls`,
        ),
      )
        .send({ partNumbers: [1] })
        .expect(200);
      const { urls } = urlsResponse.body as {
        urls: { partNumber: number; url: string }[];
      };
      const parts = await putPartsViaPresignedUrls(
        urls,
        new Map([[1, Buffer.alloc(0)]]),
      );

      const response = await complete(publicId, { parts }).expect(422);

      expect(response.body).toMatchObject({ error: 'EMPTY_FILE' });
      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: publicId });
      expect(row.status).toBe(VideoStatus.ERROR);
      expect(row.error_message).toMatch(/^EMPTY_FILE/);
    });

    it('should answer 503 ENQUEUE_FAILED and mark the video as error when publishing fails', async () => {
      const publicId = await createDraft(twoPartSize);
      const parts = await uploadTwoParts(publicId);
      jest
        .spyOn(app.get(VideoProcessingProducer), 'enqueue')
        .mockRejectedValueOnce(new Error('redis down'));

      const response = await complete(publicId, { parts }).expect(503);

      expect(response.body).toMatchObject({ error: 'ENQUEUE_FAILED' });
      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: publicId });
      expect(row.status).toBe(VideoStatus.ERROR);
      expect(row.error_message).toMatch(/^ENQUEUE_FAILED/);
    });

    it('should answer 400 INVALID_PART_NUMBER for a part above the part count', async () => {
      const publicId = await createDraft(MIB);

      const response = await complete(publicId, {
        parts: [{ partNumber: 2, etag: '"x"' }],
      }).expect(400);

      expect(response.body).toMatchObject({ error: 'INVALID_PART_NUMBER' });
    });

    it.each([
      ['an empty list', { parts: [] }],
      [
        'duplicate part numbers',
        {
          parts: [
            { partNumber: 1, etag: '"a"' },
            { partNumber: 1, etag: '"b"' },
          ],
        },
      ],
      ['an empty ETag', { parts: [{ partNumber: 1, etag: '' }] }],
      ['a missing body', {}],
    ])('should reject %s with VALIDATION_ERROR', async (_label, body) => {
      const publicId = await createDraft(MIB);

      const response = await complete(publicId, body).expect(400);

      expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    });

    it('should answer the same 404 for an unknown video and for a video of another channel', async () => {
      const publicId = await createDraft(MIB);
      const stranger = await registerConfirmAndLogin(app, dataSource);
      const body = { parts: [{ partNumber: 1, etag: '"x"' }] };

      const unknown = await complete('doesnotexist', body).expect(404);
      const foreign = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/completion`)
        .set('Authorization', `Bearer ${stranger.access_token}`)
        .send(body)
        .expect(404);

      expect(unknown.body).toEqual(foreign.body);
      expect(foreign.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    });

    it('should reject a request without token', async () => {
      await request(app.getHttpServer())
        .post('/videos/AbCdEfGh_-1/upload/completion')
        .send({ parts: [{ partNumber: 1, etag: '"x"' }] })
        .expect(401);
    });
  });

  describe('GET /videos/:publicId', () => {
    it('should return the draft to its owner without internal fields', async () => {
      const created = await authorized(
        request(app.getHttpServer()).post('/videos'),
      )
        .send({
          filename: 'aula.mp4',
          contentType: 'video/mp4',
          sizeBytes: MIB,
        })
        .expect(201);
      const { publicId } = created.body as { publicId: string };
      createdKeys.push(`videos/${publicId}/original.mp4`);

      const response = await authorized(
        request(app.getHttpServer()).get(`/videos/${publicId}`),
      ).expect(200);

      expect(response.body).toEqual({
        publicId,
        title: 'aula',
        status: 'draft',
        originalFilename: 'aula.mp4',
        contentType: 'video/mp4',
        sizeBytes: null,
        durationSeconds: null,
        metadata: null,
        errorMessage: null,
        thumbnailUrl: null,
        createdAt: expect.any(String) as string,
        updatedAt: expect.any(String) as string,
      });
    });

    it('should answer the same 404 for an unknown video and for a video of another channel', async () => {
      const created = await authorized(
        request(app.getHttpServer()).post('/videos'),
      )
        .send({
          filename: 'aula.mp4',
          contentType: 'video/mp4',
          sizeBytes: MIB,
        })
        .expect(201);
      const { publicId } = created.body as { publicId: string };
      createdKeys.push(`videos/${publicId}/original.mp4`);
      const stranger = await registerConfirmAndLogin(app, dataSource);

      const unknown = await authorized(
        request(app.getHttpServer()).get('/videos/doesnotexist'),
      ).expect(404);
      const foreign = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${stranger.access_token}`)
        .expect(404);

      expect(unknown.body).toEqual(foreign.body);
      expect(foreign.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    });

    it('should reject a request without token', async () => {
      await request(app.getHttpServer()).get('/videos/AbCdEfGh_-1').expect(401);
    });
  });

  describe('GET /videos/:publicId/stream and /download', () => {
    async function createVideo(status: VideoStatus): Promise<string> {
      const created = await authorized(
        request(app.getHttpServer()).post('/videos'),
      )
        .send({
          filename: 'aula.mp4',
          contentType: 'video/mp4',
          sizeBytes: MIB,
          title: 'Minha aula',
        })
        .expect(201);
      const { publicId } = created.body as { publicId: string };
      createdKeys.push(`videos/${publicId}/original.mp4`);
      await dataSource
        .getRepository(Video)
        .update({ public_id: publicId }, { status });
      return publicId;
    }

    it.each(['stream', 'download'])(
      'should redirect %s of a ready video to the public storage endpoint without a token',
      async (route) => {
        const publicId = await createVideo(VideoStatus.READY);

        const response = await request(app.getHttpServer())
          .get(`/videos/${publicId}/${route}`)
          .expect(302);

        const location = response.headers.location;
        expect(location.startsWith(process.env.S3_PUBLIC_ENDPOINT!)).toBe(true);
        expect(location).toContain(`videos/${publicId}/original.mp4`);
        expect(location.includes('response-content-disposition')).toBe(
          route === 'download',
        );
      },
    );

    it.each([
      ['stream', VideoStatus.DRAFT],
      ['stream', VideoStatus.PROCESSING],
      ['download', VideoStatus.ERROR],
    ])(
      'should answer 409 VIDEO_NOT_READY for %s of a %s video',
      async (route, status) => {
        const publicId = await createVideo(status);

        const response = await request(app.getHttpServer())
          .get(`/videos/${publicId}/${route}`)
          .expect(409);

        expect(response.body).toMatchObject({
          statusCode: 409,
          error: 'VIDEO_NOT_READY',
        });
      },
    );

    it.each(['stream', 'download'])(
      'should answer 404 VIDEO_NOT_FOUND for %s of an unknown video',
      async (route) => {
        const response = await request(app.getHttpServer())
          .get(`/videos/doesnotexist/${route}`)
          .expect(404);

        expect(response.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
      },
    );
  });
});
