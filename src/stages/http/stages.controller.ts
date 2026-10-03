import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors } from '../../platform/errors.js';
import type { AuthedRequest } from '../../platform/security/auth.guard.js';
import { StageEngine } from '../app/stage-engine.js';
import { StageTemplatesService } from '../app/stage-templates.service.js';
import { StagesService } from '../app/stages.service.js';
import { STAGE_CHIP } from '../domain/types.js';
import {
  AttachContributionBodyDto,
  BlockStageBodyDto,
  StageTemplateListDto,
  StageStateChangeDto,
  UnblockStageBodyDto,
  StageChoiceDto,
  StageContentBodyDto,
  StageDto,
  StageEvidenceListDto,
  StageMapDto,
  StageOptionDto,
} from './stages.dto.js';

// Prefixes avoid /v1/problems*, which is pinned to 3 public GETs (PROFILE-LOCAL-1).
// Reads are public after publication; req.auth is only present when a valid session came with the request.
@ApiTags('stages')
@Controller('v1')
export class StagesController {
  constructor(
    @Inject(StagesService) private readonly svc: StagesService,
    @Inject(StageEngine) private readonly engine: StageEngine,
    @Inject(StageTemplatesService)
    private readonly templates: StageTemplatesService,
  ) {}

  private async move(
    id: string,
    req: AuthedRequest,
    to: 'active' | 'resolving' | 'blocked',
    fields?: Record<string, unknown>,
  ) {
    const r = await this.engine.apply({
      stageId: id,
      to,
      actor: { kind: 'steward', id: req.auth!.accountId },
      fields,
    });
    return { id: r.stageId, state: r.state, chip: STAGE_CHIP[r.state] };
  }

  @Get('stage-templates')
  @ApiOperation({
    operationId: 'listStageTemplates',
    summary: 'The default stage plan templates, with starting wording',
  })
  @ApiOkResponse({ type: StageTemplateListDto })
  @ApiErrors(500)
  listTemplates() {
    return this.templates.list();
  }

  @Get('stages/by-problem/:problemId')
  @ApiOperation({
    operationId: 'listProblemStages',
    summary:
      'The stage map of a published problem: nodes, edges, chips, criteria progress',
  })
  @ApiOkResponse({ type: StageMapDto })
  @ApiErrors(404, 500)
  map(@Param('problemId') id: string, @Req() req: AuthedRequest) {
    return this.svc.map(id, req.auth?.accountId ?? null);
  }

  @Get('stages/:id')
  @ApiOperation({
    operationId: 'getStage',
    summary: 'A stage workspace: options, choice, evidence and criteria',
  })
  @ApiOkResponse({ type: StageDto })
  @ApiErrors(404, 500)
  get(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.svc.workspace(id, req.auth?.accountId ?? null);
  }

  @Post('stages/:id/options')
  @ApiOperation({
    operationId: 'addStageOption',
    summary:
      'Add an option to a stage; planned and ready stages keep it for later',
  })
  @ApiCreatedResponse({ type: StageOptionDto })
  @ApiErrors(400, 401, 404, 409, 500)
  addOption(
    @Param('id') id: string,
    @Body() b: StageContentBodyDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.addOption(id, req.auth!, b);
  }

  @Get('stage-options/:id')
  @ApiOperation({ operationId: 'getStageOption', summary: 'One stage option' })
  @ApiOkResponse({ type: StageOptionDto })
  @ApiErrors(404, 500)
  getOption(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.svc.getOption(id, req.auth?.accountId ?? null);
  }

  @Patch('stage-options/:id')
  @ApiOperation({
    operationId: 'updateStageOption',
    summary: 'Edit your option while it is pending or its stage is active',
  })
  @ApiOkResponse({ type: StageOptionDto })
  @ApiErrors(400, 401, 404, 409, 500)
  updateOption(
    @Param('id') id: string,
    @Body() b: StageContentBodyDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.updateOption(id, req.auth!, b);
  }

  @Post('stages/:id/choice')
  @ApiOperation({
    operationId: 'chooseStageOption',
    summary:
      'Record the choice of an active stage, by the decider its decision method names',
  })
  @ApiCreatedResponse({ type: StageChoiceDto })
  @ApiErrors(400, 401, 403, 404, 409, 500)
  choose(
    @Param('id') id: string,
    @Body() b: StageContentBodyDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.choose(id, req.auth!, b);
  }

  @Delete('stages/:id/choice')
  @HttpCode(204)
  @ApiOperation({
    operationId: 'withdrawStageChoice',
    summary: 'Withdraw the recorded choice while the stage is active',
  })
  @ApiNoContentResponse()
  @ApiErrors(401, 403, 404, 409, 500)
  async withdraw(@Param('id') id: string, @Req() req: AuthedRequest) {
    await this.svc.withdrawChoice(id, req.auth!);
  }

  @Post('stages/:id/evidence')
  @ApiOperation({
    operationId: 'addStageEvidence',
    summary:
      'Cite https links as evidence for one criterion of an active or blocked stage',
  })
  @ApiCreatedResponse({ type: StageEvidenceListDto })
  @ApiErrors(400, 401, 404, 409, 500)
  async evidence(
    @Param('id') id: string,
    @Body() b: StageContentBodyDto,
    @Req() req: AuthedRequest,
  ) {
    return { items: await this.svc.addEvidence(id, req.auth!, b) };
  }

  @Post('stages/:id/attach-contribution')
  @ApiOperation({
    operationId: 'attachStageContribution',
    summary:
      'Steward: attach an accepted evidence contribution (made ahead or at problem level) to an active or blocked stage as stage evidence',
  })
  @ApiCreatedResponse({ type: StageEvidenceListDto })
  @ApiErrors(400, 401, 403, 404, 409, 500)
  async attach(
    @Param('id') id: string,
    @Body() b: AttachContributionBodyDto,
    @Req() req: AuthedRequest,
  ) {
    return { items: await this.svc.attachContribution(id, req.auth!, b) };
  }

  @Post('stages/:id/start')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'startStage',
    summary: 'Start a ready stage (steward); a planned stage gets not_ready',
  })
  @ApiOkResponse({ type: StageStateChangeDto })
  @ApiErrors(401, 403, 404, 409, 500)
  start(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.move(id, req, 'active');
  }

  @Post('stages/:id/submit')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'submitStage',
    summary:
      'Submit an active stage for resolution: choice, tasks and mapped evidence are checked and the evidence is frozen',
  })
  @ApiOkResponse({ type: StageStateChangeDto })
  @ApiErrors(400, 401, 403, 404, 409, 500)
  submit(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.move(id, req, 'resolving');
  }

  @Post('stages/:id/block')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'blockStage',
    summary: 'Record a blocker on a stage (BLOCKER-1); parallel branches go on',
  })
  @ApiOkResponse({ type: StageStateChangeDto })
  @ApiErrors(400, 401, 403, 404, 409, 500)
  block(
    @Param('id') id: string,
    @Body() b: BlockStageBodyDto,
    @Req() req: AuthedRequest,
  ) {
    return this.move(id, req, 'blocked', { ...b });
  }

  @Post('stages/:id/unblock')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'unblockStage',
    summary:
      'Clear a blocker and resume the stage; on a stuck problem the note goes to the checking run first',
  })
  @ApiOkResponse({ type: StageStateChangeDto })
  @ApiErrors(400, 401, 403, 404, 409, 500)
  async unblock(
    @Param('id') id: string,
    @Body() b: UnblockStageBodyDto,
    @Req() req: AuthedRequest,
  ) {
    const r = await this.engine.unblock({
      stageId: id,
      actor: { kind: 'steward', id: req.auth!.accountId },
      fields: { ...b },
    });
    return { id: r.stageId, state: r.state, chip: STAGE_CHIP[r.state] };
  }
}
