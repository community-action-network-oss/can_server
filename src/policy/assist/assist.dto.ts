import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class AssistRequestDto {
  @ApiProperty({
    description:
      'Private notes. Never stored; the length limit is a pack value.',
  })
  @IsString()
  @MaxLength(20000)
  notes!: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Subset of form fields to help with',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  fields?: string[];
}

export class AssistSuggestionDto {
  @ApiProperty({ description: 'Content key of the form field (snake_case)' })
  field_ref!: string;
  @ApiProperty() value!: string;
  @ApiProperty({ description: 'Quote from the notes this rests on' })
  basis!: string;
  @ApiProperty() confidence!: number;
}
export class AssistQuestionDto {
  @ApiProperty() field_ref!: string;
  @ApiProperty() text!: string;
}
export class AssistResponseDto {
  @ApiProperty({
    type: [AssistSuggestionDto],
    description:
      'Proposals only. The poster accepts each field; nothing is applied.',
  })
  suggestions!: AssistSuggestionDto[];
  @ApiProperty({ type: [AssistQuestionDto] }) questions!: AssistQuestionDto[];
  @ApiProperty() assist_run_id!: string;
  @ApiProperty() policy_version!: string;
  @ApiProperty() prompt_hash!: string;
  @ApiProperty() model_id!: string;
}
