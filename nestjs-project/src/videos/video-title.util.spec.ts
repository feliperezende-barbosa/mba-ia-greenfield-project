import { deriveTitle } from './video-title.util';

describe('deriveTitle', () => {
  it('should remove the last extension', () => {
    expect(deriveTitle('aula.mp4')).toBe('aula');
    expect(deriveTitle('my.holiday.video.mkv')).toBe('my.holiday.video');
  });

  it('should trim surrounding whitespace', () => {
    expect(deriveTitle('  aula 01  .mp4')).toBe('aula 01');
  });

  it('should truncate the title to 100 characters', () => {
    const title = deriveTitle(`${'a'.repeat(150)}.mp4`);

    expect(title).toBe('a'.repeat(100));
  });

  it('should keep a name without extension as is', () => {
    expect(deriveTitle('lecture')).toBe('lecture');
  });

  it('should use the full name when there is no stem', () => {
    expect(deriveTitle('.mp4')).toBe('.mp4');
    expect(deriveTitle(`.${'b'.repeat(150)}`)).toBe(`.${'b'.repeat(99)}`);
  });

  it('should fall back to a generic title when the name is blank', () => {
    expect(deriveTitle('   ')).toBe('Untitled video');
  });
});
