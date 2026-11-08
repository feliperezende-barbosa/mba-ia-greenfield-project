import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  createMediaFixtures,
  FIXTURE_DURATION_SECONDS,
  FIXTURE_HEIGHT,
  FIXTURE_WIDTH,
  removeMediaFixtures,
  type MediaFixtures,
} from '../test/media-fixtures';
import { deleteKeys, uniqueTestPublicId } from '../test/storage-test-helpers';
import { buildOriginalKey } from '../videos/video-keys.util';
import { InvalidMediaError } from './media.errors';
import { MediaModule } from './media.module';
import { MediaService } from './media.service';

const URL_TTL_SECONDS = 300;

// Reads the width from the JPEG start-of-frame marker (SOF0/SOF2).
function jpegWidth(jpeg: Buffer): number {
  let offset = 2;
  while (offset < jpeg.length) {
    const marker = jpeg[offset + 1];
    if (jpeg[offset] === 0xff && (marker === 0xc0 || marker === 0xc2)) {
      return jpeg.readUInt16BE(offset + 7);
    }
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  throw new Error('JPEG start-of-frame marker not found');
}

describe('MediaService (integration)', () => {
  let module: TestingModule;
  let media: MediaService;
  let storage: StorageService;
  let fixtures: MediaFixtures;
  const createdKeys: string[] = [];

  async function uploadAndSign(path: string): Promise<string> {
    const key = buildOriginalKey(uniqueTestPublicId(), 'mp4');
    createdKeys.push(key);
    await storage.putObject(key, await readFile(path), 'video/mp4');
    return storage.presignInternalGetUrl(key, URL_TTL_SECONDS);
  }

  beforeAll(async () => {
    fixtures = await createMediaFixtures();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, load: [storageConfig] }),
        StorageModule,
        MediaModule,
      ],
    }).compile();
    await module.init();
    media = module.get(MediaService);
    storage = module.get(StorageService);
  }, 60_000);

  afterAll(async () => {
    await deleteKeys(storage, createdKeys);
    await module.close();
    await removeMediaFixtures(fixtures);
  });

  describe('probe', () => {
    it('should extract duration and metadata from an MP4 served by a presigned URL', async () => {
      const url = await uploadAndSign(fixtures.mp4);

      const result = await media.probe(url);

      expect(result.durationSeconds).toBeCloseTo(FIXTURE_DURATION_SECONDS, 0);
      expect(result.metadata).toEqual(
        expect.objectContaining({
          width: FIXTURE_WIDTH,
          height: FIXTURE_HEIGHT,
          video_codec: 'h264',
          audio_codec: 'aac',
        }),
      );
      expect(result.metadata.container).toContain('mp4');
      expect(result.metadata.bit_rate).toEqual(expect.any(Number));
      expect(result.metadata.size_bytes).toBeGreaterThan(0);
    });

    it('should report audio_codec null when the video has no audio track', async () => {
      const url = await uploadAndSign(fixtures.mp4NoAudio);

      const result = await media.probe(url);

      expect(result.metadata.video_codec).toBe('h264');
      expect(result.metadata.audio_codec).toBeNull();
    });

    it('should reject an audio-only file with InvalidMediaError', async () => {
      const url = await uploadAndSign(fixtures.audioOnly);

      await expect(media.probe(url)).rejects.toBeInstanceOf(InvalidMediaError);
    });

    it('should reject a text file with InvalidMediaError', async () => {
      const url = await uploadAndSign(fixtures.text);

      await expect(media.probe(url)).rejects.toBeInstanceOf(InvalidMediaError);
    });

    it('should reject a missing object with an error that is not InvalidMediaError', async () => {
      const url = await storage.presignInternalGetUrl(
        buildOriginalKey(uniqueTestPublicId(), 'mp4'),
        URL_TTL_SECONDS,
      );

      const error: unknown = await media.probe(url).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(InvalidMediaError);
    });
  });

  describe('generateThumbnail', () => {
    it('should return a 1280px wide JPEG frame', async () => {
      const url = await uploadAndSign(fixtures.mp4);

      const jpeg = await media.generateThumbnail(url, FIXTURE_DURATION_SECONDS);

      expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
      expect(jpegWidth(jpeg)).toBe(1280);
    });

    it('should reject a text file with InvalidMediaError', async () => {
      const url = await uploadAndSign(fixtures.text);

      await expect(media.generateThumbnail(url, null)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should reject a missing object with an error that is not InvalidMediaError', async () => {
      const url = await storage.presignInternalGetUrl(
        buildOriginalKey(uniqueTestPublicId(), 'mp4'),
        URL_TTL_SECONDS,
      );

      const error: unknown = await media
        .generateThumbnail(url, null)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(InvalidMediaError);
    });
  });

  describe('stalled input', () => {
    let server: Server;
    let url: string;

    beforeAll(async () => {
      // Accepts the connection and never answers, simulating a hung storage endpoint.
      server = createServer(() => undefined);
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/video.mp4`;
      Object.assign(media, { probeTimeoutMs: 500, thumbnailTimeoutMs: 500 });
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('should kill ffprobe and reject once the timeout elapses', async () => {
      const startedAt = Date.now();

      await expect(media.probe(url)).rejects.toThrow(/timed out/);

      expect(Date.now() - startedAt).toBeLessThan(10_000);
    });

    it('should kill ffmpeg and reject once the timeout elapses', async () => {
      await expect(media.generateThumbnail(url, null)).rejects.toThrow(
        /timed out/,
      );
    });
  });
});
