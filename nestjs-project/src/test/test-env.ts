// Jest runs inside the Compose network, so presigned URLs must point to the
// internal MinIO host for the test process to follow them.
if (process.env.NODE_ENV === 'test') {
  process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';
}
