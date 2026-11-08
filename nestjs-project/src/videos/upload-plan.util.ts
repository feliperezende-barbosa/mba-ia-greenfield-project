import { UPLOAD_PART_SIZE_BYTES } from './videos.constants';

export interface UploadPlan {
  partSize: number;
  partCount: number;
}

export function planUploadParts(sizeBytes: number): UploadPlan {
  return {
    partSize: UPLOAD_PART_SIZE_BYTES,
    partCount: Math.ceil(sizeBytes / UPLOAD_PART_SIZE_BYTES),
  };
}
