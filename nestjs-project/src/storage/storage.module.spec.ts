import { S3Client } from '@aws-sdk/client-s3';
import { Test } from '@nestjs/testing';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const ENV_OVERRIDES = {
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'streamtube',
  S3_ACCESS_KEY_ID: 'access',
  S3_SECRET_ACCESS_KEY: 'secret',
};

describe('StorageModule', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, ENV_OVERRIDES);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should compile with the real storageConfig and expose StorageService', async () => {
    const module = await Test.createTestingModule({
      imports: [StorageModule],
    }).compile();

    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    await module.close();
  });

  it('should create two S3 clients with distinct endpoints', async () => {
    const module = await Test.createTestingModule({
      imports: [StorageModule],
    }).compile();

    const internal = module.get<S3Client>(S3_INTERNAL_CLIENT);
    const publicClient = module.get<S3Client>(S3_PUBLIC_CLIENT);
    const internalEndpoint = await internal.config.endpoint!();
    const publicEndpoint = await publicClient.config.endpoint!();

    expect(internal).not.toBe(publicClient);
    expect(internalEndpoint.hostname).toBe('minio');
    expect(publicEndpoint.hostname).toBe('localhost');
    expect(await internal.config.forcePathStyle).toBe(true);
    expect(await internal.config.requestChecksumCalculation()).toBe(
      'WHEN_REQUIRED',
    );
    expect(await internal.config.responseChecksumValidation()).toBe(
      'WHEN_REQUIRED',
    );
    await module.close();
  });
});
