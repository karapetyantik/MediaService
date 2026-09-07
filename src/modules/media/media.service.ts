import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { ClientProxy } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { fromBuffer as detectFileType } from 'file-type';
import { PrismaService } from '@common/prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import { RequestUploadDto } from '../dto/request-upload.dto';
import { ConfirmUploadDto } from '../dto/confirm-upload.dto';
import { MAX_UPLOAD_BYTES } from './upload-limits';

const CONTENT_SNIFF_BYTES = 4100;
const UNVERIFIABLE_MIME_TYPE = 'application/octet-stream';

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
    private readonly config: ConfigService,
    @Inject('RABBITMQ_SERVICE') private readonly rabbitClient: ClientProxy,
    @Inject('USER_EVENTS_SERVICE')
    private readonly userEventsClient: ClientProxy,
  ) {}

  async requestUpload(uploaderId: string, dto: RequestUploadDto) {
    const mediaId = randomUUID();
    const objectKey = `${uploaderId}/${mediaId}${extname(dto.fileName)}`;

    await this.prisma.mediaFile.create({
      data: {
        id: mediaId,
        uploaderId,
        objectKey,
        fileName: dto.fileName,
        mimeType: dto.mimeType,
        sizeBytes: dto.sizeBytes,
        status: 'pending',
        purpose: dto.purpose ?? 'attachment',
      },
    });

    const uploadUrl = await this.s3Service.getUploadUrl(
      objectKey,
      dto.mimeType,
    );
    return { mediaId, uploadUrl, objectKey };
  }

  async confirmUpload(
    mediaId: string,
    uploaderId: string,
    dto: ConfirmUploadDto,
  ) {
    const file = await this.prisma.mediaFile.findUnique({
      where: { id: mediaId },
    });

    if (!file) throw new NotFoundException('Файл не найден');
    if (file.uploaderId !== uploaderId)
      throw new BadRequestException('Это не ваш файл');

    if (
      file.purpose === 'avatar' &&
      (dto.cropX === undefined ||
        dto.cropY === undefined ||
        dto.cropSize === undefined)
    ) {
      throw new BadRequestException(
        'Для аватара нужно указать параметры обрезки: cropX, cropY, cropSize',
      );
    }

    const { exists, sizeBytes, etag } = await this.s3Service.checkObjectExists(
      file.objectKey,
    );
    if (!exists)
      throw new BadRequestException('Файл ещё не загружен в хранилище');

    if (sizeBytes !== undefined && sizeBytes > MAX_UPLOAD_BYTES) {
      await this.rejectUpload(mediaId, file.objectKey);
      throw new BadRequestException(
        `Файл превышает максимально допустимый размер (${MAX_UPLOAD_BYTES} байт)`,
      );
    }

    await this.assertContentMatchesDeclaredType(
      mediaId,
      file.objectKey,
      file.mimeType,
    );

    if (etag && file.purpose !== 'avatar') {
      const existing = await this.prisma.mediaFile.findFirst({
        where: {
          uploaderId,
          contentHash: etag,
          status: 'confirmed',
          purpose: file.purpose,
          id: { not: mediaId },
        },
      });

      if (existing) {
        // Delete the S3 object before the DB row: if S3 delete fails, the
        // DB row survives to point at a real (if duplicate) object rather
        // than an untracked orphan sitting silently in the bucket forever.
        await this.s3Service.deleteObject(file.objectKey);
        await this.prisma.mediaFile.delete({ where: { id: mediaId } });

        return {
          mediaId: existing.id,
          url: await this.s3Service.getDownloadUrl(existing.objectKey),
          status: 'confirmed',
          reused: true,
        };
      }
    }

    const updated = await this.prisma.mediaFile.update({
      where: { id: mediaId },
      data: {
        status: 'confirmed',
        confirmedAt: new Date(),
        sizeBytes,
        contentHash: etag,
        cropX: dto.cropX,
        cropY: dto.cropY,
        cropSize: dto.cropSize,
      },
    });

    const downloadUrl = await this.s3Service.getDownloadUrl(file.objectKey);

    this.rabbitClient.emit('file.uploaded', {
      mediaId,
      uploaderId,
      url: downloadUrl,
      mimeType: file.mimeType,
      fileName: file.fileName,
      sizeBytes,
      objectKey: file.objectKey,
      purpose: file.purpose,
      crop:
        file.purpose === 'avatar'
          ? { x: dto.cropX, y: dto.cropY, size: dto.cropSize }
          : null,
    });

    return { mediaId, url: downloadUrl, status: updated.status };
  }

  async saveVariants(mediaId: string, variants: Record<string, string>) {
    const file = await this.prisma.mediaFile.update({
      where: { id: mediaId },
      data: { variants },
    });

    if (file.purpose === 'avatar' && variants.avatar) {
      this.userEventsClient.emit('avatar.updated', {
        userId: file.uploaderId,
        avatarUrl: this.buildAvatarUrl(variants.avatar),
      });
    }
  }

  private buildAvatarUrl(objectKey: string): string {
    const endpoint = this.config.getOrThrow<string>('MINIO_ENDPOINT');
    const port = this.config.getOrThrow<string>('MINIO_PORT');
    const bucket = this.config.getOrThrow<string>('AVATAR_BUCKET');
    return `http://${endpoint}:${port}/${bucket}/${objectKey}`;
  }

  /**
   * Rejects a mimeType that is client-declared metadata, never verified
   * against the actual bytes, by sniffing the real file signature. Skips
   * generic/unknown uploads (application/octet-stream) since there's
   * nothing to contradict, and only rejects on a confirmed mismatch — a
   * failed/ambiguous detection is not treated as a violation, to avoid
   * false positives on legitimate edge-case files.
   */
  private async assertContentMatchesDeclaredType(
    mediaId: string,
    objectKey: string,
    declaredMimeType: string,
  ): Promise<void> {
    if (declaredMimeType === UNVERIFIABLE_MIME_TYPE) {
      return;
    }

    const head = await this.s3Service.readHeadBytes(
      objectKey,
      CONTENT_SNIFF_BYTES,
    );
    const detected = await detectFileType(head);

    if (detected && detected.mime !== declaredMimeType) {
      this.logger.warn(
        `Заявленный тип ${declaredMimeType} не совпадает с фактическим ${detected.mime} для ${objectKey}`,
      );
      await this.rejectUpload(mediaId, objectKey);
      throw new BadRequestException(
        'Содержимое файла не соответствует заявленному типу',
      );
    }
  }

  private async rejectUpload(mediaId: string, objectKey: string) {
    await this.s3Service.deleteObject(objectKey);
    await this.prisma.mediaFile
      .delete({ where: { id: mediaId } })
      .catch(() => undefined);
  }
}
