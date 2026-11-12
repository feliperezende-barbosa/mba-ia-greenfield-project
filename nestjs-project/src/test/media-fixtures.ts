import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const FIXTURE_DURATION_SECONDS = 3;
export const FIXTURE_WIDTH = 320;
export const FIXTURE_HEIGHT = 240;
export const LARGE_FIXTURE_MIN_BYTES = 11 * 1024 ** 2;

export interface MediaFixtures {
  dir: string;
  mp4: string;
  mp4NoAudio: string;
  mp4Large: string;
  audioOnly: string;
  text: string;
}

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync('ffmpeg', ['-v', 'error', '-y', ...args]);
}

// Tiny clips are generated on the fly with lavfi sources; no binary is committed (TD-09).
export async function createMediaFixtures(): Promise<MediaFixtures> {
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-media-'));
  const mp4 = join(dir, 'with-audio.mp4');
  const mp4NoAudio = join(dir, 'no-audio.mp4');
  const mp4Large = join(dir, 'large.mp4');
  const audioOnly = join(dir, 'audio-only.m4a');
  const text = join(dir, 'not-a-video.mp4');

  const size = `${FIXTURE_WIDTH}x${FIXTURE_HEIGHT}`;
  const duration = String(FIXTURE_DURATION_SECONDS);

  await ffmpeg([
    ...['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=25`],
    ...['-f', 'lavfi', '-i', 'sine=frequency=440'],
    ...['-t', duration, '-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
    ...['-c:a', 'aac', '-shortest', mp4],
  ]);
  await ffmpeg([
    ...['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25`],
    ...['-t', duration, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4NoAudio],
  ]);
  await ffmpeg([
    ...['-f', 'lavfi', '-i', 'sine=frequency=440'],
    ...['-t', duration, '-c:a', 'aac', audioOnly],
  ]);
  // Noise at a very high bitrate makes the file big enough for a multi-part upload.
  await ffmpeg([
    ...['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=25'],
    ...['-vf', 'noise=alls=100:allf=t+u'],
    ...['-t', '5', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p'],
    mp4Large,
  ]);
  await writeFile(text, 'this is plain text, not a media file\n'.repeat(100));

  const { size: largeSize } = await stat(mp4Large);
  if (largeSize < LARGE_FIXTURE_MIN_BYTES) {
    throw new Error(
      `Large fixture too small: ${largeSize} < ${LARGE_FIXTURE_MIN_BYTES}`,
    );
  }

  return { dir, mp4, mp4NoAudio, mp4Large, audioOnly, text };
}

export async function removeMediaFixtures(
  fixtures: MediaFixtures,
): Promise<void> {
  await rm(fixtures.dir, { recursive: true, force: true });
}
