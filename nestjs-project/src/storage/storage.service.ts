import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { PRESIGNED_URL_TTL_SECONDS } from '../videos/videos.constants';
import {
  MULTIPART_ERROR_NAMES,
  S3_INTERNAL_CLIENT,
  S3_PUBLIC_CLIENT,
} from './storage.constants';
import { InvalidMultipartUploadError } from './storage.errors';

export interface PresignedPartUrl {
  partNumber: number;
  url: string;
}

export interface CompletedPartInput {
  partNumber: number;
  etag: string;
}

export interface PresignPublicGetOptions {
  expiresIn: number;
  responseContentDisposition?: string;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function isNotFound(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;
  return errorName(error) === 'NotFound' || status === 404;
}

function isMultipartError(
  name: string | undefined,
): name is (typeof MULTIPART_ERROR_NAMES)[number] {
  return (MULTIPART_ERROR_NAMES as readonly (string | undefined)[]).includes(
    name,
  );
}

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  async ensureBucket(): Promise<void> {
    const Bucket = this.config.bucket;
    try {
      await this.internalClient.send(new HeadBucketCommand({ Bucket }));
      return;
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }

    try {
      await this.internalClient.send(new CreateBucketCommand({ Bucket }));
    } catch (error) {
      // Another process (API or worker) may have created it between HEAD and CREATE.
      if (errorName(error) !== 'BucketAlreadyOwnedByYou') {
        throw error;
      }
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const response = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!response.UploadId) {
      throw new Error('Object storage did not return a multipart UploadId');
    }
    return response.UploadId;
  }

  async presignUploadPartUrls(
    key: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<PresignedPartUrl[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await getSignedUrl(
          this.publicClient,
          new UploadPartCommand({
            Bucket: this.config.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn: PRESIGNED_URL_TTL_SECONDS },
        ),
      })),
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPartInput[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map(({ partNumber, etag }) => ({
              PartNumber: partNumber,
              ETag: etag,
            })),
          },
        }),
      );
    } catch (error) {
      const name = errorName(error);
      if (isMultipartError(name)) {
        throw new InvalidMultipartUploadError(name, { cause: error });
      }
      throw error;
    }
  }

  async headObject(key: string): Promise<{ contentLength: number } | null> {
    try {
      const response = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return { contentLength: response.ContentLength ?? 0 };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  async putObject(
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async presignPublicGetUrl(
    key: string,
    options: PresignPublicGetOptions,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn: options.expiresIn },
    );
  }

  async presignInternalGetUrl(key: string, expiresIn: number): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn },
    );
  }
}
