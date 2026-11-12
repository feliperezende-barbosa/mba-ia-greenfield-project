import { generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('should return 11 characters', () => {
    expect(generatePublicId()).toHaveLength(11);
  });

  it('should only use the base64url alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('should not collide in a large sample', () => {
    const sampleSize = 50_000;
    const ids = new Set(
      Array.from({ length: sampleSize }, () => generatePublicId()),
    );

    expect(ids.size).toBe(sampleSize);
  });
});
