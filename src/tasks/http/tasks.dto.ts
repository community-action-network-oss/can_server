import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PATCHABLE } from '../domain/task-rules.js';

export class TaskBlockerDto {
  @ApiProperty() id!: string;
  @ApiProperty() text!: string;
  @ApiProperty() cleared!: boolean;
  @ApiProperty({ type: String, nullable: true }) clearedNote!: string | null;
  @ApiProperty() createdAt!: string;
}

export class TaskDto {
  @ApiProperty() id!: string;
  @ApiProperty() stageId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'The structured answers, validated against the task schema.',
  })
  content!: Record<string, unknown>;
  @ApiProperty({
    enum: ['open', 'claimed', 'in_progress', 'done', 'dropped'],
  })
  status!: string;
  @ApiProperty() required!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Handle of the person doing the task.',
  })
  assigneeHandle!: string | null;
  @ApiProperty({ type: String, nullable: true }) droppedReason!: string | null;
  @ApiProperty({ description: 'Checked by someone other than the doer.' })
  verified!: boolean;
  @ApiProperty({ type: String, nullable: true })
  verificationNote!: string | null;
  @ApiProperty({ type: [TaskBlockerDto] }) blockers!: TaskBlockerDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class TaskListDto {
  @ApiProperty({ type: [TaskDto] }) items!: TaskDto[];
}

/** A task, or the progress_update that claims or reports on one. */
export class TaskContentBodyDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Create: the task schema body. Claim and progress: a progress_update body whose task_ref is the task id.',
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

export class PatchTaskBodyDto {
  @ApiPropertyOptional({ enum: PATCHABLE })
  @IsOptional()
  @IsIn([...PATCHABLE])
  status?: string;
  @ApiPropertyOptional({ description: 'Required when dropping.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  droppedReason?: string;
  @ApiPropertyOptional({
    description: 'Set by someone other than the doer, on a done task.',
  })
  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(300)
  verificationNote?: string;
}

export class AddBlockerBodyDto {
  @ApiProperty()
  @IsString()
  @MinLength(5)
  @MaxLength(300)
  text!: string;
}

export class ClearBlockerBodyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
