import { ApiProperty } from '@nestjs/swagger';

const OBJ = { type: 'object', additionalProperties: true } as const;

export class OptionImprovementDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Public handle only.' }) authorHandle!: string;
  @ApiProperty({
    description: "True for the viewer's own item awaiting review.",
  })
  pendingReview!: boolean;
  @ApiProperty(OBJ) content!: Record<string, unknown>;
  @ApiProperty() createdAt!: string;
}
export class OptionItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() stageId!: string;
  @ApiProperty({ description: 'Public handle only.' }) authorHandle!: string;
  @ApiProperty({ enum: ['pending', 'public', 'withdrawn'] }) status!: string;
  @ApiProperty({
    description: "True for the viewer's own option awaiting review.",
  })
  pendingReview!: boolean;
  @ApiProperty() forLaterStage!: boolean;
  @ApiProperty({ ...OBJ, nullable: true, description: 'Null once withdrawn.' })
  content!: Record<string, unknown> | null;
  @ApiProperty({ type: [OptionImprovementDto] })
  improvements!: OptionImprovementDto[];
  @ApiProperty() createdAt!: string;
}
export class OptionsOrderDto {
  @ApiProperty({ enum: ['created_at_asc'] }) order!: string;
  @ApiProperty({ description: 'Always false (RANK-1).' })
  usesEngagementSignals!: boolean;
}
export class ComparisonCellDto {
  @ApiProperty() optionId!: string;
  @ApiProperty({ nullable: true, type: String }) value!: string | null;
}
export class ComparisonRowDto {
  @ApiProperty({ enum: ['mechanism', 'authority', 'cost', 'risks'] })
  field!: string;
  @ApiProperty({ type: [ComparisonCellDto] }) cells!: ComparisonCellDto[];
}
export class OptionComparisonDto {
  @ApiProperty({ type: [ComparisonRowDto] }) rows!: ComparisonRowDto[];
}
export class StageOptionsDto {
  @ApiProperty({ type: [OptionItemDto] }) items!: OptionItemDto[];
  @ApiProperty({ type: OptionsOrderDto }) criteria!: OptionsOrderDto;
  @ApiProperty({
    type: OptionComparisonDto,
    nullable: true,
    description: 'Server facts from the public options; null under 2 options.',
  })
  comparison!: OptionComparisonDto | null;
}
