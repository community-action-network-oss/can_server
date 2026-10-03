import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
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
import { ContributionsService } from '../app/contributions.service.js';
import {
  ContributionDto,
  ContributionListDto,
  CreateContributionDto,
  ListContributionsQueryDto,
  UpdateContributionDto,
} from './contributions.dto.js';

// Not under /v1/problems (pinned to 3 public GETs, PROFILE-LOCAL-1): problem scoped routes live under /v1/contributions.
@ApiTags('contributions')
@Controller('v1')
export class ContributionsController {
  constructor(
    @Inject(ContributionsService) private readonly svc: ContributionsService,
  ) {}

  @Get('contributions/by-problem/:problemId')
  @ApiOperation({
    operationId: 'listContributions',
    summary:
      'Published contributions of a problem in the order they were made, plus your own awaiting review',
  })
  @ApiOkResponse({ type: ContributionListDto })
  @ApiErrors(400, 404, 500)
  list(
    @Param('problemId') problemId: string,
    @Query() q: ListContributionsQueryDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.list(problemId, req.auth?.accountId ?? null, q);
  }

  @Post('contributions/by-problem/:problemId')
  @ApiOperation({
    operationId: 'createContribution',
    summary:
      'Reply to a problem or one of its stages with structured answers; it waits for review',
  })
  @ApiCreatedResponse({ type: ContributionDto })
  @ApiErrors(400, 401, 404, 409, 429, 500)
  create(
    @Param('problemId') problemId: string,
    @Body() b: CreateContributionDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.create(req.auth!.accountId, problemId, b);
  }

  @Patch('contributions/:id')
  @ApiOperation({
    operationId: 'updateContribution',
    summary: 'Withdraw your reply, or edit it while it awaits review',
  })
  @ApiOkResponse({ type: ContributionDto })
  @ApiErrors(400, 401, 404, 409, 500)
  update(
    @Param('id') id: string,
    @Body() b: UpdateContributionDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.update(req.auth!.accountId, id, b);
  }
}
