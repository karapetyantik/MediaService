import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './common/prisma/prisma.module';
import { S3Module } from './modules/s3/s3.module';
import { ConfigModule } from '@nestjs/config';
import { MediaModule } from './modules/media/media.module';
import { AuthModule } from './common/auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    S3Module,
    MediaModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
