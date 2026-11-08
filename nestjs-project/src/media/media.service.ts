import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import {
  FFMPEG_BIN,
  FFPROBE_BIN,
  INVALID_DATA_MARKER,
  PROBE_MAX_BUFFER_BYTES,
  PROBE_TIMEOUT_MS,
  THUMBNAIL_MAX_BUFFER_BYTES,
  THUMBNAIL_MAX_OFFSET_SECONDS,
  THUMBNAIL_OFFSET_RATIO,
  THUMBNAIL_TIMEOUT_MS,
  THUMBNAIL_WIDTH,
} from './media.constants';
import { InvalidMediaError } from './media.errors';
import type { MediaProbeResult } from './media.types';

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutput {
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
    size?: string;
  };
  streams?: FfprobeStream[];
}

interface ExecResult<T extends string | Buffer> {
  stdout: T;
  stderr: string;
}

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

@Injectable()
export class MediaService {
  // Instance fields (not bare constants) so tests can shorten them to exercise the kill path.
  private readonly probeTimeoutMs = PROBE_TIMEOUT_MS;
  private readonly thumbnailTimeoutMs = THUMBNAIL_TIMEOUT_MS;

  async probe(input: string): Promise<MediaProbeResult> {
    const { stdout } = await this.run<string>(
      FFPROBE_BIN,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        input,
      ],
      {
        encoding: 'utf8',
        timeout: this.probeTimeoutMs,
        maxBuffer: PROBE_MAX_BUFFER_BYTES,
      },
    );

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout) as FfprobeOutput;
    } catch (error) {
      throw new InvalidMediaError('ffprobe output is not valid JSON', {
        cause: error,
      });
    }

    const streams = parsed.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    if (!video) {
      throw new InvalidMediaError('no video stream found');
    }
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    const format = parsed.format ?? {};

    return {
      durationSeconds: toNumber(format.duration ?? video.duration),
      metadata: {
        container: format.format_name ?? null,
        width: video.width ?? null,
        height: video.height ?? null,
        video_codec: video.codec_name ?? null,
        audio_codec: audio?.codec_name ?? null,
        bit_rate: toNumber(format.bit_rate),
        size_bytes: toNumber(format.size),
      },
    };
  }

  computeThumbnailOffset(durationSeconds: number | null): number {
    if (
      durationSeconds === null ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0
    ) {
      return 0;
    }
    return Math.min(
      durationSeconds * THUMBNAIL_OFFSET_RATIO,
      THUMBNAIL_MAX_OFFSET_SECONDS,
    );
  }

  async generateThumbnail(
    input: string,
    durationSeconds: number | null,
  ): Promise<Buffer> {
    const offset = this.computeThumbnailOffset(durationSeconds);
    const { stdout } = await this.run<Buffer>(
      FFMPEG_BIN,
      [
        '-v',
        'error',
        '-ss',
        offset.toFixed(3),
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        `scale=${THUMBNAIL_WIDTH}:-2`,
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      {
        encoding: 'buffer',
        timeout: this.thumbnailTimeoutMs,
        maxBuffer: THUMBNAIL_MAX_BUFFER_BYTES,
      },
    );

    if (stdout.length === 0) {
      throw new InvalidMediaError('no frame could be extracted');
    }
    return stdout;
  }

  private run<T extends string | Buffer>(
    bin: string,
    args: string[],
    options: {
      encoding: 'utf8' | 'buffer';
      timeout: number;
      maxBuffer: number;
    },
  ): Promise<ExecResult<T>> {
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { ...options, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          const stderrText = stderr.toString();
          if (!error) {
            resolve({ stdout: stdout as T, stderr: stderrText });
            return;
          }
          // maxBuffer overflow also kills the child; keep it distinguishable from a timeout.
          const code: unknown = (error as NodeJS.ErrnoException).code;
          if (error.killed && code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(
              new Error(`${bin} timed out after ${options.timeout}ms`, {
                cause: error,
              }),
            );
            return;
          }
          if (stderrText.includes(INVALID_DATA_MARKER)) {
            reject(
              new InvalidMediaError(INVALID_DATA_MARKER, { cause: error }),
            );
            return;
          }
          reject(
            new Error(`${bin} failed: ${stderrText.trim() || error.message}`, {
              cause: error,
            }),
          );
        },
      );
    });
  }
}
