import { IsInt, IsOptional, Min, Max } from 'class-validator';

const MAX_CROP_DIMENSION_PX = 20000;

export class ConfirmUploadDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CROP_DIMENSION_PX)
  cropX?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CROP_DIMENSION_PX)
  cropY?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_CROP_DIMENSION_PX)
  cropSize?: number;
}
