import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class S3Service {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.getOrThrow<string>('MINIO_BUCKET');
    this.client = new S3Client({
      endpoint: `http://${this.config.getOrThrow<string>('MINIO_ENDPOINT')}:${this.config.getOrThrow<string>('MINIO_PORT')}`,
      region: 'us-east-1',
      credentials: {
        accessKeyId: this.config.getOrThrow<string>('MINIO_ACCESS_KEY'),
        secretAccessKey: this.config.getOrThrow<string>('MINIO_SECRET_KEY'),
      },
      forcePathStyle: true,
    });
  }

  async getUploadUrl(objectKey: string, mimeType: string): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ContentType: mimeType,
    });
    return getSignedUrl(this.client, command, { expiresIn: 300 });
  }

  async checkObjectExists(
    objectKey: string,
  ): Promise<{ exists: boolean; sizeBytes?: number; etag?: string }> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      return {
        exists: true,
        sizeBytes: result.ContentLength,
        etag: result.ETag ? result.ETag.replace(/"/g, '') : undefined,
      };
    } catch {
      return { exists: false };
    }
  }

  async getDownloadUrl(objectKey: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    });
    return getSignedUrl(this.client, command, { expiresIn: 3600 });
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    );
  }

  /** Reads the first `byteLength` bytes of an object — enough for magic-byte content sniffing. */
  async readHeadBytes(objectKey: string, byteLength: number): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Range: `bytes=0-${byteLength - 1}`,
      }),
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
