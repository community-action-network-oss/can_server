import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors } from '../../platform/errors.js';
import type { AuthedRequest } from '../../platform/security/auth.guard.js';
import { Roles } from '../../platform/security/decorators.js';
import { PolicyProposalsService } from '../app/policy-proposals.service.js';
import {
  AttachReportsDto,
  ListPolicyProposalsQueryDto,
  MoveStageDto,
  PolicyProposalDto,
  PolicyProposalPageDto,
  SubmitPolicyProposalDto,
} from './policy-proposals.dto.js';

// Not under /v1/problems* (pinned to 3 public GETs, PROFILE-LOCAL-1). Reads are public; "maintainer" is the admin role.
@ApiTags('policy')
@Controller('v1/policy-proposals')
export class PolicyProposalsController {
  constructor(
    @Inject(PolicyProposalsService)
    private readonly svc: PolicyProposalsService,
  ) {}

  @Post()
  @ApiOperation({
    operationId: 'submitPolicyProposal',
    summary:
      'Submit a policy proposal; protected-core changes are refused with 422 protected_core',
  })
  @ApiCreatedResponse({ type: PolicyProposalDto })
  @ApiErrors(400, 401, 409, 422, 429, 500)
  submit(@Body() b: SubmitPolicyProposalDto, @Req() req: AuthedRequest) {
    return this.svc.submit(req.auth!, b);
  }

  @Get()
  @ApiOperation({
    operationId: 'listPolicyProposals',
    summary: 'Policy proposals, newest first, optionally by stage',
  })
  @ApiOkResponse({ type: PolicyProposalPageDto })
  @ApiErrors(400, 500)
  list(@Query() q: ListPolicyProposalsQueryDto) {
    return this.svc.list(q);
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'getPolicyProposal',
    summary: 'One policy proposal with eval, replay, ratification and rollout',
  })
  @ApiOkResponse({ type: PolicyProposalDto })
  @ApiErrors(404, 500)
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Post(':id/reports')
  @HttpCode(200)
  @Roles('admin')
  @ApiOperation({
    operationId: 'attachPolicyProposalReports',
    summary:
      'Maintainers attach CI eval and replay reports; a blocked verdict moves the stage back',
  })
  @ApiOkResponse({ type: PolicyProposalDto })
  @ApiErrors(400, 401, 403, 404, 409, 500)
  reports(
    @Param('id') id: string,
    @Body() b: AttachReportsDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.attachReports(id, req.auth!, b);
  }

  @Post(':id/stage')
  @HttpCode(200)
  @Roles('admin')
  @ApiOperation({
    operationId: 'movePolicyProposalStage',
    summary: 'Maintainers move a proposal along legal stage transitions',
  })
  @ApiOkResponse({ type: PolicyProposalDto })
  @ApiErrors(400, 401, 403, 404, 409, 500)
  stage(
    @Param('id') id: string,
    @Body() b: MoveStageDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.moveStage(id, req.auth!, b);
  }
}
