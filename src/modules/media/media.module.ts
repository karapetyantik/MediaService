import { Module } from '@nestjs/common';
import { MediaService } from './media.service';
import { MediaController } from './media.controller';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { PrismaModule } from 'src/common/prisma/prisma.module';
import { S3Module } from '../s3/s3.module';
import { GrpcMediaController } from './grpc-media/grpc-media.controller';
import { MediaEventsController } from './media-events.controller';

@Module({
  imports: [
    PrismaModule,
    S3Module,
    ClientsModule.registerAsync([
      {
        name: 'RABBITMQ_SERVICE',
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: 'media_events',
            queueOptions: { durable: true },
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  providers: [MediaService],
  controllers: [MediaController, MediaEventsController, GrpcMediaController],
})
export class MediaModule {}
