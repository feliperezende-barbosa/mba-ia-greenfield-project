import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import {
  deleteKeys,
  putPartsViaPresignedUrls,
  uniqueTestPublicId,
} from '../test/storage-test-helpers';
import { buildOriginalKey, buildThumbnailKey } from '../videos/video-keys.util';
import { S3_INTERNAL_CLIENT } from './storage.constants';
import { InvalidMultipartUploadError } from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIB = 1024 * 1024;

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;
  let config: ConfigType<typeof storageConfig>;
  const createdKeys: string[] = [];

  function trackedKey(extension = 'mp4'): string {
    const key = buildOriginalKey(uniqueTestPublicId(), extension);
    createdKeys.push(key);
    return key;
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await module.init();
    storage = module.get(StorageService);
    config = module.get<ConfigType<typeof storageConfig>>(storageConfig.KEY);
  });

  afterAll(async () => {
    await deleteKeys(storage, createdKeys);
    await module.close();
  });

  describe('ensureBucket', () => {
    it('should leave the configured bucket in place and be idempotent', async () => {
      await storage.ensureBucket();
      await storage.ensureBucket();

      const client = module.get<S3Client>(S3_INTERNAL_CLIENT);
      await expect(
        client.send(new HeadBucketCommand({ Bucket: config.bucket })),
      ).resolves.toBeDefined();
    });
  });

  describe('multipart upload', () => {
    it('should upload 3 parts through presigned URLs and complete the object', async () => {
      const key = trackedKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const bodies = new Map([
        [1, Buffer.alloc(5 * MIB, 1)],
        [2, Buffer.alloc(5 * MIB, 2)],
        [3, Buffer.alloc(MIB, 3)],
      ]);

      const urls = await storage.presignUploadPartUrls(
        key,
        uploadId,
        [1, 2, 3],
      );
      const parts = await putPartsViaPresignedUrls(urls, bodies);
      await storage.completeMultipartUpload(key, uploadId, parts);

      const head = await storage.headObject(key);
      expect(head).toEqual({ contentLength: 11 * MIB });
    });

    it('should expose a readable ETag for each uploaded part', async () => {
      const key = trackedKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const urls = await storage.presignUploadPartUrls(key, uploadId, [1]);

      const parts = await putPartsViaPresignedUrls(
        urls,
        new Map([[1, Buffer.alloc(5 * MIB, 7)]]),
      );

      expect(parts).toHaveLength(1);
      expect(parts[0].etag.replace(/"/g, '')).toMatch(/^[0-9a-f]{32}$/);
    });

    it('should not sign checksum parameters into the part URLs', async () => {
      const key = trackedKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      const [{ url }] = await storage.presignUploadPartUrls(key, uploadId, [1]);

      const query = new URL(url).search.toLowerCase();
      expect(query).not.toContain('x-amz-checksum');
      expect(query).not.toContain('x-amz-sdk-checksum-algorithm');
      expect(query).toContain('partnumber=1');
    });

    it('should reject an invalid ETag with InvalidMultipartUploadError and create no object', async () => {
      const key = trackedKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const urls = await storage.presignUploadPartUrls(key, uploadId, [1]);
      await putPartsViaPresignedUrls(
        urls,
        new Map([[1, Buffer.alloc(5 * MIB, 9)]]),
      );

      const completion = storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"00000000000000000000000000000000"' },
      ]);

      await expect(completion).rejects.toBeInstanceOf(
        InvalidMultipartUploadError,
      );
      await expect(storage.headObject(key)).resolves.toBeNull();
    });
  });

  describe('headObject', () => {
    it('should return null for a key that does not exist', async () => {
      const key = buildOriginalKey(uniqueTestPublicId(), 'mp4');

      await expect(storage.headObject(key)).resolves.toBeNull();
    });
  });

  describe('putObject and presigned GET', () => {
    it('should serve a ranged GET through the public presigned URL with 206', async () => {
      const key = buildThumbnailKey(uniqueTestPublicId());
      createdKeys.push(key);
      await storage.putObject(key, Buffer.alloc(1000, 5), 'image/jpeg');

      const url = await storage.presignPublicGetUrl(key, { expiresIn: 60 });
      const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });

      expect(response.status).toBe(206);
      expect((await response.arrayBuffer()).byteLength).toBe(100);
    });

    it('should reflect responseContentDisposition in the response header', async () => {
      const key = buildThumbnailKey(uniqueTestPublicId());
      createdKeys.push(key);
      await storage.putObject(key, Buffer.alloc(10, 1), 'image/jpeg');

      const url = await storage.presignPublicGetUrl(key, {
        expiresIn: 60,
        responseContentDisposition: 'attachment; filename="holiday.jpg"',
      });
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="holiday.jpg"',
      );
    });

    it('should delete an object', async () => {
      const key = buildThumbnailKey(uniqueTestPublicId());
      await storage.putObject(key, Buffer.alloc(10, 1), 'image/jpeg');

      await storage.deleteObject(key);

      await expect(storage.headObject(key)).resolves.toBeNull();
    });
  });

  describe('presigned URL hosts', () => {
    it('should sign public URLs against S3_PUBLIC_ENDPOINT and internal URLs against S3_ENDPOINT', async () => {
      const key = buildThumbnailKey(uniqueTestPublicId());

      const publicUrl = await storage.presignPublicGetUrl(key, {
        expiresIn: 60,
      });
      const internalUrl = await storage.presignInternalGetUrl(key, 60);

      expect(publicUrl.startsWith(`${config.publicEndpoint}/`)).toBe(true);
      expect(internalUrl.startsWith(`${config.endpoint}/`)).toBe(true);
    });

    it('should serve the internal presigned URL', async () => {
      const key = buildThumbnailKey(uniqueTestPublicId());
      createdKeys.push(key);
      await storage.putObject(key, Buffer.alloc(10, 1), 'image/jpeg');

      const response = await fetch(
        await storage.presignInternalGetUrl(key, 60),
      );

      expect(response.status).toBe(200);
    });
  });
});
