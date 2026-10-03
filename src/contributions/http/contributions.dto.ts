import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { USER_TYPES } from '../domain/types.js';

const OBJ = { type: 'object', additionalProperties: true } as const;

export class CreateContributionDto {
  @ApiProperty({ enum: USER_TYPES })
  @IsIn(USER_TYPES)
  type!: string;
  @ApiPropertyOptional({
    description: 'The stage this is for; leave out to address the problem.',
  })
  @IsOptional()
  @IsUUID()
  stageId?: string;
  @ApiProperty({
    ...OBJ,
    description: 'Answers, validated against the pinned content schema.',
  })
  @IsObject()
  body!: Record<string, unknown>;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  schemaVersion?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  schemaHash?: string;
  @ApiPropertyOptional({
    description: 'A clarifying question of the same problem this answers.',
  })
  @IsOptional()
  @IsUUID()
  answersContributionId?: string;
  @ApiPropertyOptional({
    ...OBJ,
    description: 'Optional location attestation; failure means guest.',
  })
  @IsOptional()
  @IsObject()
  attestation?: Record<string, unknown>;
  @ApiPropertyOptional({
    type: [String],
    description: 'Ids of review flags the author keeps as they are.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keptFlagIds?: string[];
}

export class UpdateContributionDto {
  @ApiPropertyOptional({ description: 'true withdraws (tombstones) it.' })
  @IsOptional()
  @IsBoolean()
  withdraw?: boolean;
  @ApiPropertyOptional({
    ...OBJ,
    description: 'New answers; only while the item is awaiting review.',
  })
  @IsOptional()
  @IsObject()
  body?: Record<string, unknown>;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keptFlagIds?: string[];
}

export class ListContributionsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() stageId?: string;
  @ApiPropertyOptional({
    description: 'true: only contributions to the whole problem.',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  problemLevel?: string;
}

export class EvidenceRefDto {
  @ApiProperty() url!: string;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ enum: ['official_page', 'news', 'other'] }) category!: string;
}

export class ContributionDto {
  @ApiProperty() id!: string;
  @ApiProperty() type!: string;
  @ApiProperty({ type: String, nullable: true }) stageId!: string | null;
  @ApiProperty() forLaterStage!: boolean;
  @ApiProperty({ ...OBJ, nullable: true, description: 'null once withdrawn.' })
  body!: Record<string, unknown> | null;
  @ApiProperty({ description: 'Handle, or the label of a system actor.' })
  authorHandle!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({
    enum: ['pending_review', 'accepted', 'hidden', 'tombstoned'],
  })
  status!: string;
  @ApiProperty({ type: String, nullable: true })
  answersContributionId!: string | null;
  @ApiProperty({ type: String, nullable: true }) tombstonedAt!: string | null;
  @ApiProperty({ type: [EvidenceRefDto] }) evidenceRefs!: EvidenceRefDto[];
}

export class ListCriteriaDto {
  @ApiProperty({ enum: ['created_at_asc'] }) order!: string;
  @ApiProperty() usesEngagementSignals!: boolean;
}

export class ContributionListDto {
  @ApiProperty({ type: [ContributionDto] }) items!: ContributionDto[];
  @ApiProperty({ type: ListCriteriaDto }) criteria!: ListCriteriaDto;
}
