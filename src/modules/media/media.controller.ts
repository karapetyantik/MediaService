import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/common/auth/jwt-auth.guard';
import { MediaService } from './media.service';
import { RequestUploadDto } from '../dto/request-upload.dto';
import { EventPattern, Payload } from '@nestjs/microservices';
import { ConfirmUploadDto } from '../dto/confirm-upload.dto';

@UseGuards(JwtAuthGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('upload-url')
  requestUpload(@Req() req: any, @Body() dto: RequestUploadDto) {
    return this.mediaService.requestUpload(req.user.userId, dto);
  }

  @Post(':mediaId/confirm')
  confirm(
    @Req() req: any,
    @Param('mediaId') mediaId: string,
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.mediaService.confirmUpload(mediaId, req.user.userId, dto);
  }
}
