import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { MediaService } from './media.service';
import { PrismaService } from '@common/prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import { MAX_UPLOAD_BYTES } from './upload-limits';

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100),
]);

describe('MediaService', () => {
  let service: MediaService;
  let prisma: {
    mediaFile: {
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      findFirst: jest.Mock;
    };
  };
  let s3: {
    checkObjectExists: jest.Mock;
    deleteObject: jest.Mock;
    getDownloadUrl: jest.Mock;
    readHeadBytes: jest.Mock;
  };

  const pendingFile = {
    id: 'media1',
    uploaderId: 'user1',
    objectKey: 'user1/media1.png',
    fileName: 'photo.png',
    mimeType: 'image/png',
    purpose: 'attachment',
    status: 'pending',
  };

  beforeEach(async () => {
    prisma = {
      mediaFile: {
        findUnique: jest.fn().mockResolvedValue(pendingFile),
        update: jest.fn().mockResolvedValue({ status: 'confirmed' }),
        delete: jest.fn().mockResolvedValue(undefined),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    s3 = {
      checkObjectExists: jest
        .fn()
        .mockResolvedValue({ exists: true, sizeBytes: 100, etag: 'abc' }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      getDownloadUrl: jest.fn().mockResolvedValue('https://example.com/dl'),
      readHeadBytes: jest.fn().mockResolvedValue(PNG_BYTES),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: PrismaService, useValue: prisma },
        { provide: S3Service, useValue: s3 },
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue('test') },
        },
        { provide: 'RABBITMQ_SERVICE', useValue: { emit: jest.fn() } },
        { provide: 'USER_EVENTS_SERVICE', useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get(MediaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('confirms a matching-content, within-limit upload', async () => {
    await expect(
      service.confirmUpload('media1', 'user1', {}),
    ).resolves.toMatchObject({ status: 'confirmed' });
    expect(prisma.mediaFile.update).toHaveBeenCalled();
  });

  it('rejects and cleans up an oversized upload', async () => {
    s3.checkObjectExists.mockResolvedValue({
      exists: true,
      sizeBytes: MAX_UPLOAD_BYTES + 1,
      etag: 'abc',
    });

    await expect(service.confirmUpload('media1', 'user1', {})).rejects.toThrow(
      BadRequestException,
    );
    expect(s3.deleteObject).toHaveBeenCalledWith(pendingFile.objectKey);
    expect(prisma.mediaFile.delete).toHaveBeenCalledWith({
      where: { id: 'media1' },
    });
    expect(prisma.mediaFile.update).not.toHaveBeenCalled();
  });

  it('rejects and cleans up when actual content does not match the declared mimeType', async () => {
    // Declared image/png but the bytes on disk are a JPEG.
    s3.readHeadBytes.mockResolvedValue(
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100)]),
    );

    await expect(service.confirmUpload('media1', 'user1', {})).rejects.toThrow(
      BadRequestException,
    );
    expect(s3.deleteObject).toHaveBeenCalledWith(pendingFile.objectKey);
    expect(prisma.mediaFile.delete).toHaveBeenCalledWith({
      where: { id: 'media1' },
    });
  });

  it('skips content sniffing for application/octet-stream', async () => {
    prisma.mediaFile.findUnique.mockResolvedValue({
      ...pendingFile,
      mimeType: 'application/octet-stream',
    });
    s3.readHeadBytes.mockResolvedValue(Buffer.alloc(0));

    await expect(
      service.confirmUpload('media1', 'user1', {}),
    ).resolves.toMatchObject({ status: 'confirmed' });
    expect(s3.readHeadBytes).not.toHaveBeenCalled();
  });

  it('deletes the S3 object before the DB row on a dedup match', async () => {
    prisma.mediaFile.findFirst.mockResolvedValue({
      id: 'existing-media',
      objectKey: 'user1/existing.png',
    });

    const callOrder: string[] = [];
    s3.deleteObject.mockImplementation(() => {
      callOrder.push('s3.deleteObject');
      return Promise.resolve();
    });
    prisma.mediaFile.delete.mockImplementation(() => {
      callOrder.push('prisma.delete');
      return Promise.resolve();
    });

    const result = await service.confirmUpload('media1', 'user1', {});

    expect(result).toMatchObject({ reused: true, mediaId: 'existing-media' });
    expect(callOrder).toEqual(['s3.deleteObject', 'prisma.delete']);
  });
});
