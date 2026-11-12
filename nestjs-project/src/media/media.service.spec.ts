import { execFile } from 'node:child_process';
import { Test } from '@nestjs/testing';
import { InvalidMediaError } from './media.errors';
import { MediaService } from './media.service';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));

type ExecCallback = (
  error: (Error & { killed?: boolean; code?: string | number }) | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

const execFileMock = execFile as unknown as jest.Mock;

function respondWith(
  error: (Error & { killed?: boolean; code?: string | number }) | null,
  stdout: string | Buffer,
  stderr: string | Buffer = '',
): void {
  execFileMock.mockImplementationOnce(
    (_bin: string, _args: string[], _opts: object, callback: ExecCallback) =>
      callback(error, stdout, stderr),
  );
}

function ffprobeJson(overrides: object = {}): string {
  return JSON.stringify({
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: '3.040000',
      bit_rate: '123456',
      size: '4096',
    },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 320, height: 240 },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
    ...overrides,
  });
}

interface ExecOptions {
  encoding?: string;
  timeout: number;
  killSignal: string;
  maxBuffer: number;
}

function lastCall(): { bin: string; args: string[]; options: ExecOptions } {
  const [bin, args, options] = execFileMock.mock.calls.at(-1) as [
    string,
    string[],
    ExecOptions,
  ];
  return { bin, args, options };
}

describe('MediaService', () => {
  let service: MediaService;

  beforeEach(async () => {
    execFileMock.mockReset();
    const module = await Test.createTestingModule({
      providers: [MediaService],
    }).compile();
    service = module.get(MediaService);
  });

  describe('computeThumbnailOffset', () => {
    it.each([
      [3, 0.3],
      [50, 5],
      [100, 10],
      [1000, 10],
    ])('should use min(10%% of %p s, 10 s) = %p', (duration, expected) => {
      expect(service.computeThumbnailOffset(duration)).toBeCloseTo(expected);
    });

    it.each([[null], [0], [-4], [Number.NaN]])(
      'should use 0 when the duration is %p',
      (duration) => {
        expect(service.computeThumbnailOffset(duration)).toBe(0);
      },
    );
  });

  describe('probe', () => {
    it('should call ffprobe with an argument array, timeout and SIGKILL', async () => {
      respondWith(null, ffprobeJson());

      await service.probe('http://minio/video.mp4?sig=1');

      const { bin, args, options } = lastCall();
      expect(bin).toBe('ffprobe');
      expect(args).toEqual([
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        'http://minio/video.mp4?sig=1',
      ]);
      expect(options.timeout).toBe(60_000);
      expect(options.killSignal).toBe('SIGKILL');
      expect(options.maxBuffer).toBeGreaterThan(0);
    });

    it('should map the ffprobe JSON to duration and metadata', async () => {
      respondWith(null, ffprobeJson());

      const result = await service.probe('url');

      expect(result).toEqual({
        durationSeconds: 3.04,
        metadata: {
          container: 'mov,mp4,m4a,3gp,3g2,mj2',
          width: 320,
          height: 240,
          video_codec: 'h264',
          audio_codec: 'aac',
          bit_rate: 123456,
          size_bytes: 4096,
        },
      });
    });

    it('should map missing fields to null', async () => {
      respondWith(
        null,
        JSON.stringify({ streams: [{ codec_type: 'video' }], format: {} }),
      );

      const result = await service.probe('url');

      expect(result).toEqual({
        durationSeconds: null,
        metadata: {
          container: null,
          width: null,
          height: null,
          video_codec: null,
          audio_codec: null,
          bit_rate: null,
          size_bytes: null,
        },
      });
    });

    it('should fall back to the video stream duration when the format has none', async () => {
      respondWith(
        null,
        JSON.stringify({
          format: {},
          streams: [{ codec_type: 'video', duration: '2.5' }],
        }),
      );

      const result = await service.probe('url');

      expect(result.durationSeconds).toBe(2.5);
    });

    it('should reject with InvalidMediaError when there is no video stream', async () => {
      respondWith(
        null,
        ffprobeJson({ streams: [{ codec_type: 'audio', codec_name: 'aac' }] }),
      );

      await expect(service.probe('url')).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should reject with InvalidMediaError when ffprobe reports invalid data', async () => {
      respondWith(
        Object.assign(new Error('Command failed'), { code: 1 }),
        '',
        'x.mp4: Invalid data found when processing input\n',
      );

      await expect(service.probe('url')).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should reject with InvalidMediaError when stdout is not JSON', async () => {
      respondWith(null, 'not json');

      await expect(service.probe('url')).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should reject with a retriable error on an HTTP failure from the storage', async () => {
      respondWith(
        Object.assign(new Error('Command failed'), { code: 1 }),
        '',
        'Server returned 404 Not Found\n',
      );

      const error: unknown = await service
        .probe('url')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(InvalidMediaError);
      expect((error as Error).message).toContain('404');
    });

    it('should reject with a retriable error when the process was killed by the timeout', async () => {
      respondWith(
        Object.assign(new Error('Command failed'), { killed: true }),
        '',
      );

      const error: unknown = await service
        .probe('url')
        .catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(InvalidMediaError);
      expect((error as Error).message).toContain('timed out');
    });

    it('should not report a maxBuffer overflow as a timeout', async () => {
      respondWith(
        Object.assign(new Error('maxBuffer exceeded'), {
          killed: true,
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        }),
        '',
      );

      const error: unknown = await service
        .probe('url')
        .catch((e: unknown) => e);

      expect((error as Error).message).not.toContain('timed out');
    });

    it('should reject with a retriable error when the binary cannot be spawned', async () => {
      respondWith(
        Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' }),
        '',
      );

      const error: unknown = await service
        .probe('url')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(InvalidMediaError);
    });
  });

  describe('generateThumbnail', () => {
    it('should call ffmpeg with -ss before -i and pipe the JPEG through stdout', async () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      respondWith(null, jpeg);

      const result = await service.generateThumbnail('http://minio/v.mp4', 50);

      const { bin, args, options } = lastCall();
      expect(bin).toBe('ffmpeg');
      expect(args).toEqual([
        '-v',
        'error',
        '-ss',
        '5.000',
        '-i',
        'http://minio/v.mp4',
        '-frames:v',
        '1',
        '-vf',
        'scale=1280:-2',
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ]);
      expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
      expect(options.encoding).toBe('buffer');
      expect(options.timeout).toBe(120_000);
      expect(options.killSignal).toBe('SIGKILL');
      expect(result).toBe(jpeg);
    });

    it('should seek to 0 when the duration is missing', async () => {
      respondWith(null, Buffer.from([0xff, 0xd8]));

      await service.generateThumbnail('url', null);

      const { args } = lastCall();
      expect(args[args.indexOf('-ss') + 1]).toBe('0.000');
    });

    it('should reject with InvalidMediaError when ffmpeg outputs nothing', async () => {
      respondWith(null, Buffer.alloc(0));

      await expect(service.generateThumbnail('url', 3)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should reject with InvalidMediaError when ffmpeg reports invalid data', async () => {
      respondWith(
        Object.assign(new Error('Command failed'), { code: 1 }),
        Buffer.alloc(0),
        Buffer.from('Invalid data found when processing input'),
      );

      await expect(service.generateThumbnail('url', 3)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should reject with a retriable error when the process was killed by the timeout', async () => {
      respondWith(
        Object.assign(new Error('Command failed'), { killed: true }),
        Buffer.alloc(0),
      );

      const error: unknown = await service
        .generateThumbnail('url', 3)
        .catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(InvalidMediaError);
      expect((error as Error).message).toContain('timed out');
    });
  });
});
