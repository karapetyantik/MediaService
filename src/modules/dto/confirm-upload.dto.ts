import { IsInt, IsOptional, Min } from 'class-validator';

export class ConfirmUploadDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  cropX?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  cropY?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  cropSize?: number;
}
