const UNSAFE_FILENAME_CHARS = /[^\p{L}\p{N} ._-]/gu;

// `{title}.{ext}` limited to letters, numbers, space, dot, underscore and hyphen.
export function buildDownloadFilename(
  title: string,
  extension: string,
  fallback: string,
): string {
  const safeTitle = title.trim().replace(UNSAFE_FILENAME_CHARS, '_');
  return safeTitle ? `${safeTitle}.${extension}` : fallback;
}

// RFC 5987 attr-char excludes these although encodeURIComponent leaves them untouched.
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function buildContentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${percentEncode(filename)}`;
}
