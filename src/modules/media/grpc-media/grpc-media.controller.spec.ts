import { Test, TestingModule } from '@nestjs/testing';
import { GrpcMediaController } from './grpc-media.controller';

describe('GrpcMediaController', () => {
  let controller: GrpcMediaController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GrpcMediaController],
    }).compile();

    controller = module.get<GrpcMediaController>(GrpcMediaController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
