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

const NS = { type: String, nullable: true } as const;

export class PublicSourceDto {
  @ApiProperty() uri!: string;
  @ApiProperty({ description: 'Category id, for example official_record.' })
  category!: string;
  @ApiProperty({ description: 'Plain label for the category.' })
  categoryLabel!: string;
  @ApiProperty() establishes!: string;
}

export class PublicCriterionDto {
  @ApiProperty({ description: '1-based position.' }) ref!: number;
  @ApiProperty() statement!: string;
  @ApiProperty() measure!: string;
  @ApiProperty(NS) deadline!: string | null;
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

export class TombstoneDto {
  @ApiProperty({ enum: [true] }) tombstone!: true;
  @ApiProperty() tombstonedAt!: string;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
}

/** Detail view. Initiator-authored text is null when tombstoned (OWN-1). Never email, review content or payloads. */
export class ProblemDetailDto {
  @ApiProperty() id!: string;
  @ApiProperty() state!: string;
  @ApiProperty() label!: string;
  @ApiProperty() explanation!: string;
  @ApiProperty() nextAction!: string;
  @ApiProperty(NS) policyVersion!: string | null;
  @ApiProperty() transitional!: boolean;
  @ApiProperty() reopened!: boolean;
  @ApiProperty(NS) title!: string | null;
  @ApiProperty(NS) condition!: string | null;
  @ApiProperty(NS) affected!: string | null;
  @ApiProperty(NS) coarseArea!: string | null;
  @ApiProperty(NS) observed!: string | null;
  @ApiProperty(NS) uncertain!: string | null;
  @ApiProperty(NS) desiredOutcome!: string | null;
  @ApiProperty(NS) jurisdiction!: string | null;
  @ApiProperty() investigationNeeded!: boolean;
  @ApiProperty(NS) publishedAt!: string | null;
  @ApiProperty(NS) authorHandle!: string | null;
  @ApiProperty(NS) pauseReason!: string | null;
  @ApiProperty(NS) resumeCondition!: string | null;
  @ApiProperty(NS) duplicateOf!: string | null;
  @ApiProperty({
    ...NS,
    description: 'Title of the target, only while the target is public.',
  })
  duplicateOfTitle!: string | null;
  @ApiProperty({
    type: [PublicProblemDto],
    description: 'Public problems linked as duplicates of this one.',
  })
  duplicates!: PublicProblemDto[];
  @ApiProperty({ description: 'A count only; review content is never public.' })
  reviewCount!: number;
  @ApiProperty({
    type: [PublicSourceDto],
    description: 'Cited sources; empty until the problem is published.',
  })
  sources!: PublicSourceDto[];
  @ApiProperty({
    type: [PublicCriterionDto],
    description: 'What solved means; empty until the problem is published.',
  })
  finalCriteria!: PublicCriterionDto[];
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The stage plan version, once published.',
  })
  planVersion!: number | null;
  @ApiProperty() isSeed!: boolean;
  @ApiProperty() syntheticEvidence!: boolean;
  @ApiProperty({ type: HelpNeededDto }) help_needed!: HelpNeededDto;
  @ApiProperty({ type: TombstoneDto, nullable: true })
  tombstone!: TombstoneDto | null;
  @ApiProperty({
    type: [String],
    description:
      'Contribution types the signed-in caller may submit on the whole problem now; empty for guests.',
  })
  allowedContributionTypes!: string[];
}

export class ProblemEventDto {
  @ApiProperty() id!: string;
  @ApiProperty() type!: string;
  @ApiProperty(NS) fromState!: string | null;
  @ApiProperty(NS) toState!: string | null;
  @ApiProperty(NS) reason!: string | null;
  @ApiProperty() occurredAt!: string;
  @ApiProperty({ ...NS, description: 'Handle, only for public event types.' })
  actor!: string | null;
}

export class ProblemEventPageDto {
  @ApiProperty({ type: [ProblemEventDto] }) items!: ProblemEventDto[];
  @ApiProperty(NS) nextCursor!: string | null;
}

export class EventsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() limit?: string;
}
