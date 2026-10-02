import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
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

export class StructuredFieldsDto extends DraftFieldsDto {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Answers to the pinned content schema. Checked against the version stamped on the draft.',
  })
  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;
  @ApiPropertyOptional({
    description:
      'Schema version the form was built from; defaults to the active one on create.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  schemaVersion?: string;
  @ApiPropertyOptional({
    description:
      'Hash of that schema version; a mismatch returns schema_hash_mismatch with reload: true.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  schemaHash?: string;
}

export class CreateDraftDto extends StructuredFieldsDto {}

export class UpdateDraftDto extends StructuredFieldsDto {
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
  @ApiProperty({ type: String, nullable: true }) schemaId!: string | null;
  @ApiProperty({ type: String, nullable: true }) schemaVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) schemaHash!: string | null;
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

export class MigrationStampDto {
  @ApiProperty() schema_id!: string;
  @ApiProperty() schema_version!: string;
  @ApiProperty() schema_hash!: string;
}

export class MigrationMappingDto {
  @ApiProperty() from_path!: string;
  @ApiProperty({ description: 'Empty when the transform is drop.' })
  to_path!: string;
  @ApiProperty({ enum: ['copy', 'split', 'merge', 'drop'] })
  transform!: string;
  @ApiProperty({
    nullable: true,
    description: 'The answer that would move; null when empty.',
  })
  carried_value!: unknown;
  @ApiProperty() needs_confirmation!: boolean;
}

export class MigrationPlanDto {
  @ApiProperty({
    enum: ['pinned', 'migrated'],
    description:
      'pinned: still on the stamped version; migrated: on the current one.',
  })
  state!: string;
  @ApiProperty({ enum: ['none', 'patch', 'minor', 'major', 'rollback'] })
  bump!: string;
  @ApiProperty({ type: MigrationStampDto }) current!: MigrationStampDto;
  @ApiProperty({ type: MigrationStampDto }) target!: MigrationStampDto;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Major bumps only: the draft must migrate before submit after this time.',
  })
  grace_ends_at!: string | null;
  @ApiProperty({ type: [MigrationMappingDto] }) mapping!: MigrationMappingDto[];
  @ApiProperty({
    type: [String],
    description: 'Newly required fields nothing maps into; asked fresh.',
  })
  new_required!: string[];
  @ApiProperty({
    type: [String],
    description: 'Answers that have no place in the new form.',
  })
  dropped!: string[];
}

export class ConfirmMappingDto {
  @ApiProperty() @IsString() @MaxLength(200) from_path!: string;
  @ApiProperty() @IsString() @MaxLength(200) to_path!: string;
}

export class ConfirmMigrationDto {
  @ApiProperty({
    description: 'The version you last saw; a mismatch returns 409.',
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
  @ApiProperty({
    type: [ConfirmMappingDto],
    description:
      'The mappings you accept. Copies always apply; unlisted split, merge and drop mappings are skipped.',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConfirmMappingDto)
  mappings!: ConfirmMappingDto[];
}
