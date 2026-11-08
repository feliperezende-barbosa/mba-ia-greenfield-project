export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 ** 3;
export const UPLOAD_PART_SIZE_BYTES = 64 * 1024 ** 2;
export const MAX_UPLOAD_PARTS = 160;
export const PRESIGNED_URL_TTL_SECONDS = 3600;
export const PUBLIC_ID_BYTES = 8;
export const PUBLIC_ID_MAX_RETRIES = 5;

export const VIDEO_CONTENT_TYPE_EXTENSIONS = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
} as const;

export type VideoContentType = keyof typeof VIDEO_CONTENT_TYPE_EXTENSIONS;
