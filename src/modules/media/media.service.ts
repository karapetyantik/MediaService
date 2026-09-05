import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { ClientProxy } from '@nestjs/microservices';
import { PrismaService } from 'src/common/prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import { RequestUploadDto } from '../dto/request-upload.dto';
import { ConfirmUploadDto } from '../dto/confirm-upload.dto';

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
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
        await this.prisma.mediaFile.delete({ where: { id: mediaId } });
        await this.s3Service.deleteObject(file.objectKey);

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
      const avatarUrl = `http://localhost:9000/chat-alpha-avatars/${variants.avatar}`;
      this.userEventsClient.emit('avatar.updated', {
        userId: file.uploaderId,
        avatarUrl,
      });
    }
  }
}
