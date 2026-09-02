import {
  IsString,
  IsIn,
  MaxLength,
  IsOptional,
  IsInt,
  Min,
} from 'class-validator';

export class RequestUploadDto {
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsOptional()
  @IsIn(['attachment', 'avatar'])
  purpose?: 'attachment' | 'avatar';

  @IsIn([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'application/pdf',
    'application/octet-stream',
  ])
  mimeType!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  sizeBytes?: number;
}
