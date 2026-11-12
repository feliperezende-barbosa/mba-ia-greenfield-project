export class InvalidMultipartUploadError extends Error {
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`Multipart upload could not be completed: ${reason}`, options);
    this.name = 'InvalidMultipartUploadError';
  }
}
