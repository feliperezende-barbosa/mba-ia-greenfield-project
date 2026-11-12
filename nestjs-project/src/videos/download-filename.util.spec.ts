import {
  buildContentDisposition,
  buildDownloadFilename,
} from './download-filename.util';

describe('buildDownloadFilename', () => {
  it('should join the title and the extension', () => {
    expect(buildDownloadFilename('Minha aula', 'mp4', 'aula.mp4')).toBe(
      'Minha aula.mp4',
    );
  });

  it('should keep letters, numbers, space, dot, underscore and hyphen', () => {
    expect(buildDownloadFilename('a-b_c.d 1', 'webm', 'x.webm')).toBe(
      'a-b_c.d 1.webm',
    );
  });

  it.each(['a/b', 'a\\b', 'a"b', 'a:b*c?'])(
    'should replace unsafe characters in %s with underscores',
    (title) => {
      const filename = buildDownloadFilename(title, 'mp4', 'fallback.mp4');

      expect(filename).toMatch(/^a_b/);
      expect(filename).not.toMatch(/[/\\":*?]/);
    },
  );

  it('should keep non-ASCII letters', () => {
    expect(buildDownloadFilename('Educação', 'mp4', 'x.mp4')).toBe(
      'Educação.mp4',
    );
  });

  it('should fall back to the original filename when the title is blank', () => {
    expect(buildDownloadFilename('   ', 'mp4', 'original.mp4')).toBe(
      'original.mp4',
    );
  });
});

describe('buildContentDisposition', () => {
  it('should build an attachment header with an ASCII fallback and the encoded filename', () => {
    expect(buildContentDisposition('Minha aula.mp4')).toBe(
      `attachment; filename="Minha aula.mp4"; filename*=UTF-8''Minha%20aula.mp4`,
    );
  });

  it('should replace non-ASCII characters in the fallback and percent-encode them in filename*', () => {
    expect(buildContentDisposition('Educação.mp4')).toBe(
      `attachment; filename="Educa__o.mp4"; filename*=UTF-8''Educa%C3%A7%C3%A3o.mp4`,
    );
  });

  it('should neutralise quotes and backslashes of an arbitrary filename', () => {
    const header = buildContentDisposition('a"b\\c\'d(e).mp4');

    expect(header).toContain('filename="a_b_c\'d(e).mp4"');
    expect(header).toContain(`filename*=UTF-8''a%22b%5Cc%27d%28e%29.mp4`);
  });
});
