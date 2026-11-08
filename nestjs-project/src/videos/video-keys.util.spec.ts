import { buildOriginalKey, buildThumbnailKey } from './video-keys.util';

describe('buildOriginalKey', () => {
  it('should place the original under the public id prefix with the given extension', () => {
    expect(buildOriginalKey('AbCdEfGh_-1', 'mp4')).toBe(
      'videos/AbCdEfGh_-1/original.mp4',
    );
  });

  it('should reflect each allow-listed extension', () => {
    expect(buildOriginalKey('abc', 'mkv')).toBe('videos/abc/original.mkv');
    expect(buildOriginalKey('abc', 'mov')).toBe('videos/abc/original.mov');
  });
});

describe('buildThumbnailKey', () => {
  it('should place a jpeg thumbnail under the public id prefix', () => {
    expect(buildThumbnailKey('AbCdEfGh_-1')).toBe(
      'videos/AbCdEfGh_-1/thumbnail.jpg',
    );
  });
});
