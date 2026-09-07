import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@common/auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '@common/auth/authenticated-request.interface';
import { MediaService } from './media.service';
import { RequestUploadDto } from '../dto/request-upload.dto';
import { ConfirmUploadDto } from '../dto/confirm-upload.dto';

@UseGuards(JwtAuthGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('upload-url')
  requestUpload(
    @Req() req: AuthenticatedRequest,
    @Body() dto: RequestUploadDto,
  ) {
    return this.mediaService.requestUpload(req.user.userId, dto);
  }

  @Post(':mediaId/confirm')
  confirm(
    @Req() req: AuthenticatedRequest,
    @Param('mediaId') mediaId: string,
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.mediaService.confirmUpload(mediaId, req.user.userId, dto);
  }
}
