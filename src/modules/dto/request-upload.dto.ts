import {
  IsString,
  IsIn,
  MaxLength,
  IsOptional,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { MAX_UPLOAD_BYTES } from '../media/upload-limits';

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

  // Client-declared size — advisory only, the authoritative check happens
  // against the actual uploaded object size in confirmUpload().
  @IsInt()
  @Min(1)
  @Max(MAX_UPLOAD_BYTES)
  sizeBytes!: number;
}
