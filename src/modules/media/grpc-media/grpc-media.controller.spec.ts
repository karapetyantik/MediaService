import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GrpcMediaController } from './grpc-media.controller';
import { PrismaService } from '@common/prisma/prisma.service';
import { S3Service } from '@modules/s3/s3.service';

describe('GrpcMediaController', () => {
  let controller: GrpcMediaController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GrpcMediaController],
      providers: [
        { provide: PrismaService, useValue: {} },
        { provide: S3Service, useValue: {} },
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue('test-key') },
        },
      ],
    }).compile();

    controller = module.get<GrpcMediaController>(GrpcMediaController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
