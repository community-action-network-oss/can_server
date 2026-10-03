import { ApiProperty } from '@nestjs/swagger';

export class LegalFindingDto {
  @ApiProperty({ enum: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'] }) layer!: string;
  @ApiProperty({
    enum: ['constrains', 'permits', 'none_found', 'conflict', 'not_applicable'],
  })
  finding!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '`<id>@<semver>[+hash12]`; null only for not_applicable.',
  })
  corpus_version!: string | null;
  @ApiProperty({ type: [String], description: 'Article ids only, never text.' })
  article_ids!: string[];
  @ApiProperty() blocks!: boolean;
}
export class LegalGateDto {
  @ApiProperty({ enum: ['clear', 'blocked'] }) outcome!: string;
  @ApiProperty() packVersion!: string;
  @ApiProperty() checkedAt!: string;
  @ApiProperty({ type: [LegalFindingDto] }) findings!: LegalFindingDto[];
}
export class DecisionRecordDto {
  @ApiProperty() id!: string;
  @ApiProperty() stageChoiceId!: string;
  @ApiProperty() method!: string;
  @ApiProperty() rationale!: string;
  @ApiProperty({ description: 'Public handle of the decider.' })
  deciderHandle!: string;
  @ApiProperty() authority!: string;
  @ApiProperty({ type: [String], nullable: true })
  dissentNotes!: string[] | null;
  @ApiProperty() transitional!: boolean;
  @ApiProperty({ type: String, nullable: true }) policyVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) decidedUnder!: string | null;
  @ApiProperty({ type: String, nullable: true })
  transitionalNote!: string | null;
  @ApiProperty({ description: 'True once the choice was withdrawn.' })
  withdrawn!: boolean;
  @ApiProperty() decidedAt!: string;
  @ApiProperty({ type: LegalGateDto }) legalGate!: LegalGateDto;
}
export class StageDecisionDto {
  @ApiProperty() stageId!: string;
  @ApiProperty({
    enum: ['not_needed', 'recorded', 'missing'],
    description: 'Derived from the live decision record only.',
  })
  choiceGate!: string;
  @ApiProperty({ type: [DecisionRecordDto] }) items!: DecisionRecordDto[];
}
