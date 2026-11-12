import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSpec } from './openapi-export';

describe('exportSpec (integration)', () => {
  let outputPath: string;
  let document: Record<string, unknown>;

  beforeAll(async () => {
    outputPath = join(tmpdir(), `openapi-test-${Date.now()}.json`);
    await exportSpec(outputPath);
    document = JSON.parse(readFileSync(outputPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  }, 30_000);

  it('exports a valid OpenAPI 3.x document', () => {
    expect(document.openapi).toMatch(/^3\./);
  });

  it('sets info.title to "StreamTube API"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.title).toBe('StreamTube API');
  });

  it('sets info.version to "1.0"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.version).toBe('1.0');
  });

  it('includes access-token Bearer security scheme', () => {
    const components = document.components as Record<string, unknown>;
    const schemes = components.securitySchemes as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemes['access-token']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('includes non-empty components.schemas from DTO inference', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
  });

  it('includes ApiErrorEnvelope schema with expected properties', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemas['ApiErrorEnvelope']).toBeDefined();
    const props = schemas['ApiErrorEnvelope'].properties as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('statusCode');
    expect(props).toHaveProperty('error');
    expect(props).toHaveProperty('message');
    expect(props).toHaveProperty('code');
  });

  it('has at least one path with a 401 response referencing ApiErrorEnvelope', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const apiErrorRef = '#/components/schemas/ApiErrorEnvelope';

    const hasRef = Object.values(paths).some((methods) =>
      Object.values(methods).some((operation) => {
        const responses = operation.responses as Record<
          string,
          Record<string, unknown>
        >;
        const r401 = responses?.['401'];
        if (!r401) return false;
        const content = r401.content as Record<string, Record<string, unknown>>;
        const jsonContent = content?.['application/json'];
        const schema = jsonContent?.schema as Record<string, unknown>;
        return schema?.['$ref'] === apiErrorRef;
      }),
    );

    expect(hasRef).toBe(true);
  });

  it('protected auth endpoints include access-token security requirement', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const protectedPaths = [
      { path: '/auth/logout', method: 'post' },
      { path: '/auth/me', method: 'get' },
    ];

    for (const { path, method } of protectedPaths) {
      const operation = paths[path]?.[method];
      expect(operation).toBeDefined();
      const security = operation?.security as Array<Record<string, unknown>>;
      expect(security).toBeDefined();
      expect(security.some((req) => 'access-token' in req)).toBe(true);
    }
  });

  it('all auth endpoints have a non-empty summary', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const authPaths = Object.entries(paths).filter(([p]) =>
      p.startsWith('/auth/'),
    );

    expect(authPaths.length).toBeGreaterThan(0);

    for (const [, methods] of authPaths) {
      for (const operation of Object.values(methods)) {
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      }
    }
  });

  describe('videos endpoints', () => {
    type Operation = Record<string, unknown>;
    const VIDEO_OPERATIONS = [
      { path: '/videos', method: 'post', protectedRoute: true },
      {
        path: '/videos/{publicId}/upload/part-urls',
        method: 'post',
        protectedRoute: true,
      },
      {
        path: '/videos/{publicId}/upload/completion',
        method: 'post',
        protectedRoute: true,
      },
      { path: '/videos/{publicId}', method: 'get', protectedRoute: true },
      {
        path: '/videos/{publicId}/stream',
        method: 'get',
        protectedRoute: false,
      },
      {
        path: '/videos/{publicId}/download',
        method: 'get',
        protectedRoute: false,
      },
    ];

    function operationOf(path: string, method: string): Operation {
      const paths = document.paths as Record<string, Record<string, Operation>>;
      const operation = paths[path]?.[method];
      expect(operation).toBeDefined();
      return operation;
    }

    it.each(VIDEO_OPERATIONS)(
      '$method $path has a summary and a description',
      ({ path, method }) => {
        const operation = operationOf(path, method);

        expect(operation.summary).toEqual(expect.any(String));
        expect((operation.summary as string).length).toBeGreaterThan(0);
        expect(operation.description).toEqual(expect.any(String));
        expect((operation.description as string).length).toBeGreaterThan(0);
      },
    );

    it.each(VIDEO_OPERATIONS)(
      '$method $path declares access-token security only when it is protected',
      ({ path, method, protectedRoute }) => {
        const security = operationOf(path, method).security as
          | Array<Record<string, unknown>>
          | undefined;

        if (protectedRoute) {
          expect(security?.some((req) => 'access-token' in req)).toBe(true);
        } else {
          expect(security).toBeUndefined();
        }
      },
    );

    it.each(VIDEO_OPERATIONS)(
      '$method $path references ApiErrorEnvelope in every error response',
      ({ path, method }) => {
        const responses = operationOf(path, method).responses as Record<
          string,
          { content?: Record<string, { schema?: Record<string, unknown> }> }
        >;
        const errorStatuses = Object.keys(responses).filter(
          (status) => Number(status) >= 400,
        );

        expect(errorStatuses.length).toBeGreaterThan(0);
        for (const status of errorStatuses) {
          expect(
            responses[status].content?.['application/json']?.schema?.['$ref'],
          ).toBe('#/components/schemas/ApiErrorEnvelope');
        }
      },
    );

    it('documents the redirect of stream and download as 302 with a Location header', () => {
      for (const path of [
        '/videos/{publicId}/stream',
        '/videos/{publicId}/download',
      ]) {
        const responses = operationOf(path, 'get').responses as Record<
          string,
          { headers?: Record<string, unknown> }
        >;

        expect(responses['302']?.headers).toHaveProperty('Location');
      }
    });

    it('documents the owner video resource with its response schema', () => {
      const responses = operationOf('/videos/{publicId}', 'get')
        .responses as Record<
        string,
        { content?: Record<string, { schema?: Record<string, unknown> }> }
      >;
      const components = document.components as Record<string, unknown>;
      const schemas = components.schemas as Record<
        string,
        { properties: Record<string, unknown> }
      >;

      expect(responses['200'].content?.['application/json']?.schema).toEqual({
        $ref: '#/components/schemas/VideoResponseDto',
      });
      expect(Object.keys(schemas['VideoResponseDto'].properties)).toEqual(
        expect.arrayContaining([
          'publicId',
          'status',
          'durationSeconds',
          'metadata',
          'errorMessage',
          'thumbnailUrl',
        ]),
      );
      expect(schemas['VideoResponseDto'].properties).not.toHaveProperty(
        'storage_key',
      );
    });
  });
});
