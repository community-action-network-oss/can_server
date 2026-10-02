import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { isPublicState, STATES } from '../../domain/lifecycle/vocabulary.js';

export class HelpNeededDto {
  @ApiProperty({ type: [String] }) skill_groups!: string[];
  @ApiProperty({ type: [String] }) languages!: string[];
  @ApiProperty({ type: String, nullable: true }) coarse_place!: string | null;
  @ApiProperty({ type: [String] }) topics!: string[];
}

export class PublicProblemDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() state!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ type: String, nullable: true }) jurisdiction!: string | null;
  @ApiProperty({ type: String, nullable: true }) coarseArea!: string | null;
  @ApiProperty() investigationNeeded!: boolean;
  @ApiProperty() publishedAt!: string;
  @ApiProperty({ type: String, nullable: true }) policyVersion!: string | null;
  @ApiProperty() transitional!: boolean;
  @ApiProperty() reopened!: boolean;
  @ApiProperty() isSeed!: boolean;
  @ApiProperty() syntheticEvidence!: boolean;
  @ApiProperty({ type: HelpNeededDto }) help_needed!: HelpNeededDto;
}

/** RANK-1: how the list is ordered, stated in every response. */
export class ListCriteriaDto {
  @ApiProperty({ enum: ['published_at_desc'] }) order!: 'published_at_desc';
  @ApiProperty({ enum: [false] }) usesEngagementSignals!: false;
}

export class PublicProblemPageDto {
  @ApiProperty({ type: [PublicProblemDto] }) items!: PublicProblemDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({ type: ListCriteriaDto }) criteria!: ListCriteriaDto;
}

/** The only inputs: paging, a public coarse region shard and public-attribute filters. Never a profile (PROFILE-LOCAL-1). */
export class ListProblemsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() limit?: string;
  @ApiPropertyOptional({ description: 'Public coarse region shard id.' })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9_]{0,63}$/)
  region?: string;
  @ApiPropertyOptional({ description: 'Filter by a public state.' })
  @IsOptional()
  @IsIn(STATES.filter((x) => isPublicState(x, true)))
  state?: string;
  @ApiPropertyOptional({ description: 'Filter by jurisdiction id.' })
  @IsOptional()
  @IsUUID()
  jurisdictionId?: string;
  @ApiPropertyOptional({
    description: 'Plain text match on title and condition.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
