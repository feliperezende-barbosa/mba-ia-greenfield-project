import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { Video } from '../src/videos/entities/video.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  type AuthenticatedTestUser,
  registerConfirmAndLogin,
} from '../src/test/auth-test-helpers';
import { deleteKeys } from '../src/test/storage-test-helpers';
import { StorageService } from '../src/storage/storage.service';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let user: AuthenticatedTestUser;
  const createdKeys: string[] = [];

  beforeAll(async () => {
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
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await deleteKeys(storage, createdKeys);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
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
});
