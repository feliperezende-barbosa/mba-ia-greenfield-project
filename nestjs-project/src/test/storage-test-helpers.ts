import { generatePublicId } from '../videos/public-id.util';
import type {
  CompletedPartInput,
  PresignedPartUrl,
  StorageService,
} from '../storage/storage.service';

// Each test/suite gets its own key prefix so suites never touch each other's objects.
export function uniqueTestPublicId(): string {
  return generatePublicId();
}

export async function deleteKeys(
  storage: StorageService,
  keys: string[],
): Promise<void> {
  for (const key of keys) {
    await storage.deleteObject(key);
  }
}

export async function putPartsViaPresignedUrls(
  urls: PresignedPartUrl[],
  bodies: Map<number, Buffer>,
): Promise<CompletedPartInput[]> {
  const parts: CompletedPartInput[] = [];
  for (const { partNumber, url } of urls) {
    const body = bodies.get(partNumber);
    if (!body) {
      throw new Error(`No body provided for part ${partNumber}`);
    }
    const response = await fetch(url, {
      method: 'PUT',
      body: new Blob([new Uint8Array(body)]),
    });
    if (!response.ok) {
      throw new Error(
        `Part ${partNumber} upload failed: ${response.status} ${await response.text()}`,
      );
    }
    const etag = response.headers.get('etag');
    if (!etag) {
      throw new Error(`Part ${partNumber} response has no ETag header`);
    }
    parts.push({ partNumber, etag });
  }
  return parts;
}
