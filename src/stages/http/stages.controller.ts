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
import { StagesService } from '../app/stages.service.js';
import {
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
  constructor(@Inject(StagesService) private readonly svc: StagesService) {}

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
}
