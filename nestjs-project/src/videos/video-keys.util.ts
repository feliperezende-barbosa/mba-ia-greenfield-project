export function buildOriginalKey(publicId: string, extension: string): string {
  return `videos/${publicId}/original.${extension}`;
}

export function buildThumbnailKey(publicId: string): string {
  return `videos/${publicId}/thumbnail.jpg`;
}
