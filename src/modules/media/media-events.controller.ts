import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { MediaService } from './media.service';

@Controller()
export class MediaEventsController {
  constructor(private readonly mediaService: MediaService) {}

  @EventPattern('image.processed')
  async handleImageProcessed(
    @Payload() data: { mediaId: string; variants: Record<string, string> },
  ) {
    await this.mediaService.saveVariants(data.mediaId, data.variants);
  }
}
