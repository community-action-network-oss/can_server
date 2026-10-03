import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrors } from '../../../platform/errors.js';
import type { AuthedRequest } from '../../../platform/security/auth.guard.js';
import { StageOptionsDto } from './stage-options.dto.js';
import { StageOptionsService } from './stage-options.service.js';

@ApiTags('stages')
@Controller('v1')
export class StageOptionsController {
  constructor(
    @Inject(StageOptionsService) private readonly svc: StageOptionsService,
  ) {}

  @Get('stages/:id/options')
  @ApiOperation({
    operationId: 'listStageOptions',
    summary:
      'Public options of a stage in creation order, with improvements and a comparison',
  })
  @ApiOkResponse({ type: StageOptionsDto })
  @ApiErrors(404, 500)
  list(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.svc.list(id, req.auth?.accountId ?? null);
  }
}
