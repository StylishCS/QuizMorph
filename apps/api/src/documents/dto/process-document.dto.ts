import { IsInt, IsOptional, Min, IsBoolean, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';

export class ProcessDocumentDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  customPages?: boolean;

  @ValidateIf((o) => o.customPages === true)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageStart?: number;

  @ValidateIf((o) => o.customPages === true)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageEnd?: number;
}

export class GenerateFormDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  timerEnabled?: boolean;
}
