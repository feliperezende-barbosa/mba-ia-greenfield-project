import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from './queue.config';

const QUEUE_ENV_KEYS = ['REDIS_HOST', 'REDIS_PORT', 'QUEUE_PREFIX'] as const;

const loadConfig = async (
  env: Partial<Record<(typeof QUEUE_ENV_KEYS)[number], string>>,
): Promise<ConfigType<typeof queueConfig>> => {
  QUEUE_ENV_KEYS.forEach((key) => delete process.env[key]);
  Object.assign(process.env, env);

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [queueConfig] }),
    ],
  }).compile();

  const config = module.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
  await module.close();
  return config;
};

describe('queueConfig', () => {
  const originalEnv = Object.fromEntries(
    QUEUE_ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  afterEach(() => {
    QUEUE_ENV_KEYS.forEach((key) => {
      const original = originalEnv[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    });
  });

  it('should map the environment variables to the config', async () => {
    const config = await loadConfig({
      REDIS_HOST: 'cache',
      REDIS_PORT: '6380',
      QUEUE_PREFIX: 'custom',
    });

    expect(config).toEqual({ host: 'cache', port: 6380, prefix: 'custom' });
  });

  it('should coerce REDIS_PORT to a number', async () => {
    const config = await loadConfig({ REDIS_PORT: '6381' });

    expect(config.port).toBe(6381);
    expect(typeof config.port).toBe('number');
  });

  it('should apply the defaults when no variable is set', async () => {
    const config = await loadConfig({});

    expect(config).toEqual({ host: 'redis', port: 6379, prefix: 'bull' });
  });
});
