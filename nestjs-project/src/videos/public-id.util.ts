import { randomBytes } from 'node:crypto';
import { PUBLIC_ID_BYTES } from './videos.constants';

export function generatePublicId(): string {
  return randomBytes(PUBLIC_ID_BYTES).toString('base64url');
}
