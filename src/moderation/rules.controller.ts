import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiErrors, ApiException } from '../platform/errors.js';
import { PolicyStore } from '../policy/app/policy-store.js';
import { PolicyUnavailable } from '../policy/domain/pack.js';

export class RuleDto {
  @ApiProperty() id!: string;
  @ApiProperty() plainText!: string;
  @ApiProperty() tier!: string;
  @ApiProperty() enforcement!: string;
}
export class RulesDto {
  @ApiProperty() policyVersion!: string;
  @ApiProperty({ type: [RuleDto] }) items!: RuleDto[];
}
export class RulesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  jurisdiction?: string;
}

/** Public rule registry. Served from the active policy pack, never duplicated in code or tables. */
@ApiTags('moderation')
@Controller('v1/rules')
export class RulesController {
  constructor(private readonly store: PolicyStore) {}

  @Get()
  @ApiOperation({
    operationId: 'listRules',
    summary: 'Rules of the active policy pack',
  })
  @ApiOkResponse({ type: RulesDto })
  @ApiErrors(400, 503)
  list(@Query() q: RulesQueryDto): RulesDto {
    try {
      const p = this.store.active(q.jurisdiction ?? 'default');
      return {
        policyVersion: p.version,
        items: p.rules.map((r) => ({
          id: r.id,
          plainText: r.text,
          tier: r.tier,
          enforcement: r.enforcement,
        })),
      };
    } catch (e) {
      if (e instanceof PolicyUnavailable)
        throw new ApiException(503, 'policy_unavailable', e.message);
      throw e;
    }
  }
}
