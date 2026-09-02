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
    private readonly s3: S3Service,
    @Inject('RABBITMQ_SERVICE') private readonly rabbitClient: ClientProxy,
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

    const uploadUrl = await this.s3.getUploadUrl(objectKey, dto.mimeType);
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

    const { exists, sizeBytes } = await this.s3.checkObjectExists(
      file.objectKey,
    );
    if (!exists)
      throw new BadRequestException('Файл ещё не загружен в хранилище');

    const updated = await this.prisma.mediaFile.update({
      where: { id: mediaId },
      data: {
        status: 'confirmed',
        confirmedAt: new Date(),
        sizeBytes,
        cropX: dto.cropX,
        cropY: dto.cropY,
        cropSize: dto.cropSize,
      },
    });

    const downloadUrl = await this.s3.getDownloadUrl(file.objectKey);

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
    await this.prisma.mediaFile.update({
      where: { id: mediaId },
      data: { variants },
    });
  }
}
