import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

export class ContentSchemaQueryDto {
  @ApiPropertyOptional({
    description:
      'Policy version string, e.g. base@0.0.1+0123456789ab. Defaults to the active one.',
  })
  @IsOptional()
  @IsString()
  version?: string;

  @ApiPropertyOptional({
    description: 'Jurisdiction id. Defaults to the default pack.',
  })
  @IsOptional()
  @Matches(/^[a-z0-9][a-z0-9-]*$/)
  jurisdiction?: string;
}

export class ContentSchemaDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'JSON Schema with x-ui, x-guidance, x-checks',
  })
  schema!: Record<string, unknown>;
  @ApiProperty() schema_id!: string;
  @ApiProperty() schema_version!: string;
  @ApiProperty({ description: 'sha256 of the schema file' })
  schema_hash!: string;
  @ApiProperty() policy_version!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Parsed messages.en.json for this type',
  })
  messages!: Record<string, unknown>;
}

export class ErrorBodyDto {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  fieldErrors?: Record<string, string>;
}

export class ErrorEnvelopeDto {
  @ApiProperty({ type: ErrorBodyDto }) error!: ErrorBodyDto;
}
