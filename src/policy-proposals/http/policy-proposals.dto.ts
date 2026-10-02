import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { STAGES } from '../domain/stages.js';

const OBJ = { type: 'object', additionalProperties: true } as const;

/** Envelope is camelCase; `content` is the snake_case policy_proposal body, validated against the pinned schema (D-82). */
export class SubmitPolicyProposalDto {
  @ApiProperty({ ...OBJ, description: 'The policy_proposal content body.' })
  @IsObject()
  content!: Record<string, unknown>;
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
}

export class AttachReportsDto {
  @ApiPropertyOptional({
    ...OBJ,
    description: 'can_policy tools/eval.mjs --json output.',
  })
  @IsOptional()
  @IsObject()
  eval?: Record<string, unknown>;
  @ApiPropertyOptional({
    ...OBJ,
    description: 'can_policy replay report (replay-report.schema.json).',
  })
  @IsOptional()
  @IsObject()
  replay?: Record<string, unknown>;
  @ApiPropertyOptional({ description: 'The can_policy pull request.' })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(300)
  prUrl?: string;
}

export class MoveStageDto {
  @ApiProperty({ enum: STAGES }) @IsIn(STAGES) to!: string;
  @ApiPropertyOptional({ description: 'Short public reason.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class ListPolicyProposalsQueryDto {
  @ApiPropertyOptional({ enum: STAGES })
  @IsOptional()
  @IsIn(STAGES)
  stage?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() limit?: string;
}

export class EvalRowDto {
  @ApiProperty({ description: 'Key: <decision point>.<metric>.' })
  name!: string;
  @ApiProperty({ enum: ['passed', 'did_not_pass'] }) status!: string;
}
export class ReplaySummaryDto {
  @ApiProperty() verdict!: string;
  @ApiProperty() changed!: number;
  @ApiProperty() of!: number;
  @ApiProperty() expected!: number;
  @ApiProperty() unexpected!: number;
  @ApiProperty() stricter!: number;
  @ApiProperty() morePermissive!: number;
}
export class RatificationStateDto {
  @ApiProperty({
    enum: ['not_started', 'waiting_for_panel', 'ratified', 'closed'],
  })
  panelStatus!: string;
  @ApiProperty({ description: 'True while founder stewardship applies.' })
  transitional!: boolean;
}
export class RolloutStageDto {
  @ApiProperty({ enum: ['shadow', 'canary', 'full'] }) stage!: string;
  @ApiProperty({ format: 'date-time' }) at!: string;
}

export class PolicyProposalSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: STAGES }) stage!: string;
  @ApiProperty() schemaVersion!: string;
  @ApiProperty({ nullable: true, type: String }) prUrl!: string | null;
  @ApiProperty({ type: String, description: 'body.change_summary.' })
  changeSummary!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class PolicyProposalDto extends PolicyProposalSummaryDto {
  @ApiProperty({ ...OBJ, description: 'The submitted snake_case body.' })
  body!: Record<string, unknown>;
  @ApiProperty() protectedCoreFlag!: boolean;
  @ApiProperty({ type: [EvalRowDto], nullable: true })
  eval!: EvalRowDto[] | null;
  @ApiProperty({ type: ReplaySummaryDto, nullable: true })
  replay!: ReplaySummaryDto | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Why the latest report blocks the proposal, as a key list.',
  })
  blockedReason!: string | null;
  @ApiProperty({ type: RatificationStateDto })
  ratification!: RatificationStateDto;
  @ApiProperty({ type: [RolloutStageDto] }) rollout!: RolloutStageDto[];
}

export class PolicyProposalPageDto {
  @ApiProperty({ type: [PolicyProposalSummaryDto] })
  items!: PolicyProposalSummaryDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}
