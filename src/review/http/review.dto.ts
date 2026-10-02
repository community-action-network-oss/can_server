import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class OptInDto {
  @ApiProperty() optedIn!: boolean;
  @ApiProperty({ nullable: true, type: String }) since!: string | null;
}

export class QueueItemDto {
  @ApiProperty() problemId!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Masked.' })
  title!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Masked.' })
  coarseArea!: string | null;
  @ApiProperty() stageCount!: number;
  @ApiProperty() sourceCount!: number;
  @ApiProperty({ enum: ['new', 'in_progress', 'finished'] }) mine!: string;
}
export class QueueDto {
  @ApiProperty({ type: [QueueItemDto] }) items!: QueueItemDto[];
}

export class DeclareDto {
  @ApiProperty({
    description: 'Must be true: you have no conflict of interest.',
  })
  @IsBoolean()
  noConflict!: boolean;
}
export class SessionDto {
  @ApiProperty() problemId!: string;
  @ApiProperty() conflictDeclaredAt!: string;
  @ApiProperty() finished!: boolean;
}

export class MaskedProblemDto {
  @ApiProperty() problemId!: string;
  @ApiProperty() version!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string', nullable: true },
    description: 'Masked text fields; personal data never appears.',
  })
  fields!: Record<string, string | null>;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Masked structured body: sources, final acceptance criteria and stage plan (snake_case).',
  })
  content!: Record<string, unknown>;
  @ApiProperty() redactionCount!: number;
}

export class CreateRecommendationDto {
  @ApiProperty({
    description:
      'A field or metadata path, e.g. stage_plan.map_faults.criteria.',
  })
  @IsString()
  @MaxLength(80)
  path!: string;
  @ApiProperty() @IsString() @MaxLength(2000) recommendation!: string;
  @ApiProperty() @IsString() @MaxLength(2000) reason!: string;
}
export class CreatedRecommendationDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['open'] }) status!: string;
}

export class FinishDto {
  @ApiProperty({ enum: ['recommendations', 'no_changes'] })
  @IsIn(['recommendations', 'no_changes'])
  outcome!: 'recommendations' | 'no_changes';
}
export class FinishedDto {
  @ApiProperty({ enum: ['recommendations', 'no_changes'] }) outcome!: string;
  @ApiProperty() finishedAt!: string;
}

export class MyRecommendationDto {
  @ApiProperty() id!: string;
  @ApiProperty() path!: string;
  @ApiProperty() recommendation!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: ['open', 'accepted', 'declined'] }) status!: string;
  @ApiProperty({ nullable: true, type: String }) resolutionReason!:
    string | null;
  @ApiProperty() changedSince!: boolean;
  @ApiProperty() createdAt!: string;
}
export class AggregateDto {
  @ApiProperty() finishedReviews!: number;
  @ApiProperty() open!: number;
  @ApiProperty() accepted!: number;
  @ApiProperty() declined!: number;
}
export class MyReviewDto {
  @ApiProperty() version!: number;
  @ApiProperty() finished!: boolean;
  @ApiProperty({ type: [MyRecommendationDto] })
  recommendations!: MyRecommendationDto[];
  @ApiProperty({
    type: AggregateDto,
    nullable: true,
    description: 'Only after you finish.',
  })
  aggregate!: AggregateDto | null;
}

export class PosterRecommendationDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Volunteer 1' }) volunteer!: string;
  @ApiProperty() path!: string;
  @ApiProperty() recommendation!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: ['open', 'accepted', 'declined'] }) status!: string;
  @ApiProperty({ nullable: true, type: String }) resolutionReason!:
    string | null;
  @ApiProperty() changedSince!: boolean;
  @ApiProperty() openedAt!: string;
}
export class PosterRecommendationsDto {
  @ApiProperty({ type: [PosterRecommendationDto] })
  items!: PosterRecommendationDto[];
}

export class ResolveDto {
  @ApiProperty({ enum: ['accept', 'decline'] })
  @IsIn(['accept', 'decline'])
  decision!: 'accept' | 'decline';
  @ApiProperty({ description: 'Required, with either answer.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason!: string;
  @ApiPropertyOptional({
    description:
      'With accept: the new value of a top-level path, applied to the draft.',
  })
  @IsOptional()
  value?: unknown;
  @ApiPropertyOptional({ description: 'Required when value is sent.' })
  @IsOptional()
  @IsInt()
  expectedVersion?: number;
}
export class ResolvedDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['accepted', 'declined'] }) status!: string;
  @ApiProperty() resolutionReason!: string;
}

export class ReviewStatusDto {
  @ApiProperty() reviewCount!: number;
  @ApiProperty() dayCount!: number;
  @ApiProperty() openRecommendations!: number;
  @ApiProperty() quorumMet!: boolean;
  @ApiProperty() canRequestPublication!: boolean;
  @ApiProperty() needsReviewers!: boolean;
}
export class PublicationRequestedDto {
  @ApiProperty({ enum: [true] }) requested!: boolean;
}
