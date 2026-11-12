import { planUploadParts } from './upload-plan.util';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

describe('planUploadParts', () => {
  it('should plan a single 64 MiB part size for any file', () => {
    expect(planUploadParts(1).partSize).toBe(64 * MIB);
  });

  it.each([
    ['1 byte', 1, 1],
    ['exactly 64 MiB', 64 * MIB, 1],
    ['64 MiB + 1 byte', 64 * MIB + 1, 2],
    ['150 MiB', 150 * MIB, 3],
    ['10 GiB', 10 * GIB, 160],
  ])('should plan the part count for %s', (_label, sizeBytes, partCount) => {
    expect(planUploadParts(sizeBytes).partCount).toBe(partCount);
  });
});
