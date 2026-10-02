import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

// Length limits (code points) are enforced in DraftsService with fieldErrors; MaxLength here is only a cheap body cap.
const CAP = 2000;

export class DraftFieldsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(CAP)
  title?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(CAP)
  condition?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(CAP)
  affected?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  coarseArea?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(CAP)
  desiredOutcome?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(CAP)
  observed?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(CAP)
  uncertain?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() jurisdictionId?: string;
}

export class CreateDraftDto extends DraftFieldsDto {}

export class UpdateDraftDto extends DraftFieldsDto {
  @ApiProperty({
    description: 'The version you last saw; a mismatch returns 409.',
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class DraftDto {
  @ApiProperty() id!: string;
  @ApiProperty() state!: string;
  @ApiProperty() version!: number;
  @ApiProperty() updatedAt!: string;
}

export class MyProblemDto {
  @ApiProperty() id!: string;
  @ApiProperty() state!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ type: String, nullable: true }) title!: string | null;
  @ApiProperty() updatedAt!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The exact date this item is deleted, or null.',
  })
  deleteAfter!: string | null;
  @ApiProperty({ type: String, nullable: true }) appealableUntil!:
    string | null;
  @ApiProperty() canWithdraw!: boolean;
  @ApiProperty() canEdit!: boolean;
  @ApiProperty() reviewCount!: number;
  @ApiProperty() needsReviewers!: boolean;
}

export class MyProblemPageDto {
  @ApiProperty({ type: [MyProblemDto] }) items!: MyProblemDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class MyProblemsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() limit?: string;
}
