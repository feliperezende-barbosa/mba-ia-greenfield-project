// Non-retriable: the input is not a readable video, retrying cannot fix it.
export class InvalidMediaError extends Error {
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid media: ${reason}`, options);
    this.name = 'InvalidMediaError';
  }
}
