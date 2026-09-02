import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { PrismaService } from 'src/common/prisma/prisma.service';
import { S3Service } from 'src/modules/s3/s3.service';

@Controller()
export class GrpcMediaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
  ) {}

  @GrpcMethod('MediaInternal', 'VerifyMedia')
  async verifyMedia(data: { mediaId: string; uploaderId: string }) {
    const file = await this.prisma.mediaFile.findUnique({
      where: { id: data.mediaId },
    });

    if (
      !file ||
      file.uploaderId !== data.uploaderId ||
      file.status !== 'confirmed'
    ) {
      return { valid: false, url: '', mimeType: '' };
    }

    const url = await this.s3Service.getDownloadUrl(file.objectKey);
    return { valid: true, url, mimeType: file.mimeType };
  }
}
