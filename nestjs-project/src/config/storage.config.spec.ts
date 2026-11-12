import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from './storage.config';

const STORAGE_ENV_KEYS = [
  'S3_ENDPOINT',
  'S3_PUBLIC_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;

const loadConfig = async (
  env: Partial<Record<(typeof STORAGE_ENV_KEYS)[number], string>>,
): Promise<ConfigType<typeof storageConfig>> => {
  STORAGE_ENV_KEYS.forEach((key) => delete process.env[key]);
  Object.assign(process.env, env);

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [storageConfig] }),
    ],
  }).compile();

  const config = module.get<ConfigType<typeof storageConfig>>(
    storageConfig.KEY,
  );
  await module.close();
  return config;
};

describe('storageConfig', () => {
  const originalEnv = Object.fromEntries(
    STORAGE_ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  afterEach(() => {
    STORAGE_ENV_KEYS.forEach((key) => {
      const original = originalEnv[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    });
  });

  it('should have S3_PUBLIC_ENDPOINT forced to the internal host by the test setup', () => {
    expect(originalEnv.S3_PUBLIC_ENDPOINT).toBe('http://minio:9000');
  });

  it('should map the environment variables to the config', async () => {
    const config = await loadConfig({
      S3_ENDPOINT: 'http://storage:9000',
      S3_PUBLIC_ENDPOINT: 'https://cdn.example.com',
      S3_REGION: 'sa-east-1',
      S3_BUCKET: 'videos-bucket',
      S3_ACCESS_KEY_ID: 'access',
      S3_SECRET_ACCESS_KEY: 'secret',
    });

    expect(config).toEqual({
      endpoint: 'http://storage:9000',
      publicEndpoint: 'https://cdn.example.com',
      region: 'sa-east-1',
      bucket: 'videos-bucket',
      accessKeyId: 'access',
      secretAccessKey: 'secret',
    });
  });

  it('should apply the defaults for optional variables', async () => {
    const config = await loadConfig({
      S3_ACCESS_KEY_ID: 'access',
      S3_SECRET_ACCESS_KEY: 'secret',
    });

    expect(config.endpoint).toBe('http://minio:9000');
    expect(config.publicEndpoint).toBe('http://localhost:9000');
    expect(config.region).toBe('us-east-1');
    expect(config.bucket).toBe('streamtube');
  });
});
