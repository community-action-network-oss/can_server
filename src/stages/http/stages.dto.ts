import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MaxLength,
} from 'class-validator';

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

export class AllowedStageTransitionDto {
  @ApiProperty({ description: 'The state the stage moves to.' }) to!: string;
  @ApiProperty({
    type: [String],
    description: 'Field keys the request must carry.',
  })
  requires!: string[];
  @ApiProperty({ enum: ['direct'] }) mode!: 'direct';
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
  @ApiProperty({
    type: [AllowedStageTransitionDto],
    description: 'What the viewer may do with this stage now.',
  })
  allowedStageTransitions!: AllowedStageTransitionDto[];
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
  @ApiProperty({
    type: [AllowedStageTransitionDto],
    description: 'What the viewer may do with this stage now.',
  })
  allowedStageTransitions!: AllowedStageTransitionDto[];
}
export class StageEvidenceListDto {
  @ApiProperty({ type: [StageEvidenceDto] }) items!: StageEvidenceDto[];
}

const text = (max: number) => [IsString(), IsNotEmpty(), MaxLength(max)];
const apply = (ds: PropertyDecorator[]) => (t: object, k: string) =>
  ds.forEach((d) => d(t, k));

/** BLOCKER-1: everything a block must say (ST07). */
export class BlockStageBodyDto {
  @ApiProperty() @apply(text(2000)) blocker!: string;
  @ApiProperty({ description: 'The rule, order or fact that blocks.' })
  @apply(text(500))
  source!: string;
  @ApiProperty() @apply(text(100)) sourceVersion!: string;
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  blockedActions!: string[];
  @ApiProperty() @apply(text(1000)) recheckCondition!: string;
  @ApiProperty({ description: 'The next lawful route.' })
  @apply(text(2000))
  nextRoute!: string;
  @ApiProperty({
    type: [String],
    description: 'Documented attempts, 1 or more.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  attempts!: string[];
}

/** ST08: the blocker was cleared, with evidence. */
export class UnblockStageBodyDto {
  @ApiProperty() @apply(text(2000)) clearedNote!: string;
  @ApiProperty({
    type: [String],
    description: 'https links or evidence ids that show the blocker is gone.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  evidence!: string[];
}

export class StageStateChangeDto {
  @ApiProperty() id!: string;
  @ApiProperty() state!: string;
  @ApiProperty({ description: 'Chip text for the new state.' }) chip!: string;
}

export class AttachContributionBodyDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() contributionId!: string;
  @ApiProperty({
    type: [Number],
    description: '1-based criterion numbers of this stage the links support.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  @Min(1, { each: true })
  criterionRefs!: number[];
}

export class TemplateCriterionDto {
  @ApiProperty() statement!: string;
  @ApiProperty() measure!: string;
}
export class TemplateStageDto {
  @ApiProperty({ description: 'Plan slug.' }) name!: string;
  @ApiProperty() label!: string;
  @ApiProperty() goal!: string;
  @ApiProperty() decisionMethod!: string;
  @ApiProperty({ type: [String] }) dependsOn!: string[];
  @ApiProperty() needsChoice!: boolean;
  @ApiProperty() required!: boolean;
  @ApiProperty({ type: [TemplateCriterionDto] })
  criteria!: TemplateCriterionDto[];
}
export class StageTemplateDto {
  @ApiProperty({ enum: ['classic-5', 'one-stage'] }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: [TemplateStageDto] }) stages!: TemplateStageDto[];
  @ApiProperty({ type: [TemplateCriterionDto] })
  finalCriteria!: TemplateCriterionDto[];
}
export class StageTemplateListDto {
  @ApiProperty({ type: [StageTemplateDto] }) items!: StageTemplateDto[];
}
