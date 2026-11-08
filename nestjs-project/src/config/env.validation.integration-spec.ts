import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY_ID: 's3-access-key',
  S3_SECRET_ACCESS_KEY: 's3-secret-key',
};

const validate = (
  env: Record<string, string>,
  omit: (keyof typeof requiredEnv)[] = [],
) => {
  const base: Record<string, string> = { ...requiredEnv };
  omit.forEach((key) => delete base[key]);
  return envValidationSchema.validate(
    { ...base, ...env },
    { allowUnknown: true, abortEarly: false },
  );
};

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage (S3)', () => {
  it.each(['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const)(
    'should reject a missing %s',
    (key) => {
      const { error } = validate({}, [key]);
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should apply the storage defaults when optional vars are not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.S3_ENDPOINT).toBe('http://minio:9000');
    expect(value.S3_PUBLIC_ENDPOINT).toBe('http://localhost:9000');
    expect(value.S3_REGION).toBe('us-east-1');
    expect(value.S3_BUCKET).toBe('streamtube');
  });

  it.each(['S3_ENDPOINT', 'S3_PUBLIC_ENDPOINT'] as const)(
    'should reject %s when it is not a URI',
    (key) => {
      const { error } = validate({ [key]: 'not a uri' });
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );
});

describe('envValidationSchema — queue (Redis)', () => {
  it('should apply the queue defaults when vars are not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.QUEUE_PREFIX).toBe('bull');
  });

  it('should coerce REDIS_PORT to a number', () => {
    const { value, error } = validate({ REDIS_PORT: '6380' });
    expect(error).toBeUndefined();
    expect(value.REDIS_PORT).toBe(6380);
  });

  it('should reject a non-numeric REDIS_PORT', () => {
    const { error } = validate({ REDIS_PORT: 'abc' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });
});
