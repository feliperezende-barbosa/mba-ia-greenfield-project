import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import type storageConfig from '../config/storage.config';
import { InvalidMultipartUploadError } from './storage.errors';
import { StorageService } from './storage.service';

const config: ConfigType<typeof storageConfig> = {
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://localhost:9000',
  region: 'us-east-1',
  bucket: 'streamtube',
  accessKeyId: 'access',
  secretAccessKey: 'secret',
};

function s3Error(name: string, httpStatusCode?: number): Error {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode },
  });
}

describe('StorageService', () => {
  let send: jest.Mock;
  let service: StorageService;

  beforeEach(() => {
    send = jest.fn();
    const internalClient = { send } as unknown as S3Client;
    const publicClient = { send: jest.fn() } as unknown as S3Client;
    service = new StorageService(internalClient, publicClient, config);
  });

  describe('ensureBucket', () => {
    it('should not create the bucket when it already exists', async () => {
      send.mockResolvedValueOnce({});

      await service.ensureBucket();

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
    });

    it('should create the bucket when HeadBucket reports it is missing', async () => {
      send
        .mockRejectedValueOnce(s3Error('NotFound', 404))
        .mockResolvedValueOnce({});

      await service.ensureBucket();

      expect(send).toHaveBeenCalledTimes(2);
      const createCommand = send.mock.calls[1][0] as CreateBucketCommand;
      expect(createCommand).toBeInstanceOf(CreateBucketCommand);
      expect(createCommand.input.Bucket).toBe('streamtube');
    });

    it('should tolerate a concurrent creation of the bucket', async () => {
      send
        .mockRejectedValueOnce(s3Error('NotFound', 404))
        .mockRejectedValueOnce(s3Error('BucketAlreadyOwnedByYou', 409));

      await expect(service.ensureBucket()).resolves.toBeUndefined();
    });

    it('should propagate HeadBucket errors other than not-found without creating', async () => {
      send.mockRejectedValueOnce(s3Error('AccessDenied', 403));

      await expect(service.ensureBucket()).rejects.toThrow('AccessDenied');
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('should propagate CreateBucket errors', async () => {
      send
        .mockRejectedValueOnce(s3Error('NotFound', 404))
        .mockRejectedValueOnce(s3Error('InternalError', 500));

      await expect(service.ensureBucket()).rejects.toThrow('InternalError');
    });
  });

  describe('completeMultipartUpload', () => {
    const parts = [{ partNumber: 1, etag: '"abc"' }];

    it.each([
      'InvalidPart',
      'InvalidPartOrder',
      'EntityTooSmall',
      'NoSuchUpload',
    ])(
      'should map the S3 error %s to InvalidMultipartUploadError',
      async (name) => {
        send.mockRejectedValueOnce(s3Error(name, 400));

        const completion = service.completeMultipartUpload(
          'videos/x/original.mp4',
          'upload-1',
          parts,
        );

        await expect(completion).rejects.toBeInstanceOf(
          InvalidMultipartUploadError,
        );
        await expect(completion).rejects.toMatchObject({ reason: name });
      },
    );

    it('should propagate unrelated S3 errors unchanged', async () => {
      const failure = s3Error('InternalError', 500);
      send.mockRejectedValueOnce(failure);

      await expect(
        service.completeMultipartUpload('k', 'u', parts),
      ).rejects.toBe(failure);
    });

    it('should send the parts with their numbers and ETags', async () => {
      send.mockResolvedValueOnce({});

      await service.completeMultipartUpload('k', 'u', parts);

      const command = send.mock.calls[0][0] as CompleteMultipartUploadCommand;
      expect(command.input).toMatchObject({
        Bucket: 'streamtube',
        Key: 'k',
        UploadId: 'u',
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"abc"' }] },
      });
    });
  });

  describe('headObject', () => {
    it('should return null when the object does not exist', async () => {
      send.mockRejectedValueOnce(s3Error('NotFound', 404));

      await expect(service.headObject('missing')).resolves.toBeNull();
    });

    it('should propagate other errors', async () => {
      send.mockRejectedValueOnce(s3Error('AccessDenied', 403));

      await expect(service.headObject('k')).rejects.toThrow('AccessDenied');
    });
  });
});
