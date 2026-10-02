import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

const OBJ = { type: 'object', additionalProperties: true } as const;

/** Wire body (snake_case, validated against the pinned content schema) plus an optional schema pin. */
export class StageContentBodyDto {
  @ApiProperty({
    ...OBJ,
    description: 'The content-schema body for this type.',
  })
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

export class StageNodeDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Plan slug.' }) name!: string;
  @ApiProperty() label!: string;
  @ApiProperty() goal!: string;
  @ApiProperty() state!: string;
  @ApiProperty({ description: 'Chip text for the state.' }) chip!: string;
  @ApiProperty() decisionMethod!: string;
  @ApiProperty() required!: boolean;
  @ApiProperty() needsChoice!: boolean;
  @ApiProperty({ type: [String] }) dependsOn!: string[];
  @ApiProperty() current!: boolean;
  @ApiProperty() ordinal!: number;
  @ApiProperty() criteriaTotal!: number;
  @ApiProperty() criteriaWithEvidence!: number;
}
export class StageEdgeDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
}
export class FinalCriterionDto {
  @ApiProperty({ description: '1-based position.' }) ref!: number;
  @ApiProperty() statement!: string;
  @ApiProperty() measure!: string;
  @ApiProperty({ nullable: true, type: String }) deadline!: string | null;
}
export class StageMapDto {
  @ApiProperty() problemId!: string;
  @ApiProperty() problemState!: string;
  @ApiProperty() planVersion!: number;
  @ApiProperty({ nullable: true, type: String }) label!: string | null;
  @ApiProperty() activeStages!: number;
  @ApiProperty({ type: [StageNodeDto], description: 'In topological order.' })
  stages!: StageNodeDto[];
  @ApiProperty({ type: [StageEdgeDto] }) edges!: StageEdgeDto[];
  @ApiProperty({ type: [FinalCriterionDto] })
  finalCriteria!: FinalCriterionDto[];
}

export class StageCriterionDto {
  @ApiProperty({ description: '1-based position, the wire criterion_ref.' })
  ref!: number;
  @ApiProperty() id!: string;
  @ApiProperty() statement!: string;
  @ApiProperty() measure!: string;
  @ApiProperty({ nullable: true, type: String }) target!: string | null;
  @ApiProperty({ nullable: true, type: String }) evidenceHint!: string | null;
  @ApiProperty({ nullable: true, type: String }) deadline!: string | null;
  @ApiProperty() hasEvidence!: boolean;
}
export class StageOptionDto {
  @ApiProperty() id!: string;
  @ApiProperty() stageId!: string;
  @ApiProperty({ description: 'Public handle only.' }) authorHandle!: string;
  @ApiProperty({ enum: ['pending', 'public', 'hidden', 'withdrawn'] })
  status!: string;
  @ApiProperty() forLaterStage!: boolean;
  @ApiProperty(OBJ) content!: Record<string, unknown>;
  @ApiProperty() createdAt!: string;
}
export class StageChoiceDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: [String] }) optionIds!: string[];
  @ApiProperty({ type: 'array', items: OBJ, nullable: true }) steps!:
    unknown[] | null;
  @ApiProperty() decisionMethod!: string;
  @ApiProperty({ description: 'A role, never a person.' }) deciderRole!: string;
  @ApiProperty() authority!: string;
  @ApiProperty() rationale!: string;
  @ApiProperty({ type: [String], nullable: true }) dissentNotes!:
    string[] | null;
  @ApiProperty({ ...OBJ, nullable: true }) gateResult!: Record<
    string,
    unknown
  > | null;
  @ApiProperty() createdAt!: string;
}
export class StageEvidenceDto {
  @ApiProperty() id!: string;
  @ApiProperty() url!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ type: [Number] }) criterionRefs!: number[];
  @ApiProperty({ description: 'Public handle only.' }) authorHandle!: string;
  @ApiProperty({ nullable: true, type: String }) tier!: string | null;
  @ApiProperty() createdAt!: string;
}
export class StageDto {
  @ApiProperty() id!: string;
  @ApiProperty() problemId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() label!: string;
  @ApiProperty() goal!: string;
  @ApiProperty() state!: string;
  @ApiProperty() chip!: string;
  @ApiProperty() decisionMethod!: string;
  @ApiProperty() required!: boolean;
  @ApiProperty() needsChoice!: boolean;
  @ApiProperty() planVersion!: number;
  @ApiProperty({ type: [StageCriterionDto] }) criteria!: StageCriterionDto[];
  @ApiProperty({ type: [StageOptionDto] }) options!: StageOptionDto[];
  @ApiProperty({ type: StageChoiceDto, nullable: true })
  choice!: StageChoiceDto | null;
  @ApiProperty({
    type: 'array',
    items: OBJ,
    description: 'Placeholder until tasks land.',
  })
  tasks!: unknown[];
  @ApiProperty({ type: [StageEvidenceDto] }) evidence!: StageEvidenceDto[];
  @ApiProperty({ type: [String] }) allowedContributionTypes!: string[];
}
export class StageEvidenceListDto {
  @ApiProperty({ type: [StageEvidenceDto] }) items!: StageEvidenceDto[];
}
