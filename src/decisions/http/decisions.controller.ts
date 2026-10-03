import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrors } from '../../platform/errors.js';
import type { AuthedRequest } from '../../platform/security/auth.guard.js';
import { DecisionRecordService } from '../app/decision-records.service.js';
import { StageDecisionDto } from './decisions.dto.js';

// Read only: records are insert-only, so there is no PATCH or DELETE.
@ApiTags('stages')
@Controller('v1')
export class DecisionsController {
  constructor(
    @Inject(DecisionRecordService) private readonly svc: DecisionRecordService,
  ) {}

  @Get('stages/:id/decision')
  @ApiOperation({
    operationId: 'getStageDecision',
    summary:
      'The decision records of a stage with the layered legal check, public after publish',
  })
  @ApiOkResponse({ type: StageDecisionDto })
  @ApiErrors(404, 500)
  get(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.svc.read(id, req.auth?.accountId ?? null);
  }
}
