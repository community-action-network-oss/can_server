import {
  Body,
  Controller,
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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors } from '../../platform/errors.js';
import type { AuthedRequest } from '../../platform/security/auth.guard.js';
import { TasksService } from '../app/tasks.service.js';
import {
  AddBlockerBodyDto,
  ClearBlockerBodyDto,
  PatchTaskBodyDto,
  TaskContentBodyDto,
  TaskDto,
  TaskListDto,
} from './tasks.dto.js';

// Prefixes avoid /v1/problems*, which is pinned to 3 public GETs (PROFILE-LOCAL-1).
@ApiTags('tasks')
@Controller('v1')
export class TasksController {
  constructor(@Inject(TasksService) private readonly svc: TasksService) {}

  @Get('stages/:id/tasks')
  @ApiOperation({
    operationId: 'listStageTasks',
    summary: 'The steps of a stage in creation order, with their blockers',
  })
  @ApiOkResponse({ type: TaskListDto })
  @ApiErrors(404, 500)
  list(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.svc.list(id, req.auth?.accountId ?? null);
  }

  @Post('stages/:id/tasks')
  @ApiOperation({
    operationId: 'createStageTask',
    summary:
      'Poster or steward: add a step to an active stage (after a passed choice when the stage needs one). Not a reply.',
  })
  @ApiCreatedResponse({ type: TaskDto })
  @ApiErrors(400, 401, 403, 404, 409, 500)
  create(
    @Param('id') id: string,
    @Body() b: TaskContentBodyDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.create(id, req.auth!, b);
  }

  @Post('tasks/:id/claim')
  @ApiOperation({
    operationId: 'claimTask',
    summary:
      'Claim an open task with a progress_update naming it; one winner. Counts as a reply (D-85).',
  })
  @ApiCreatedResponse({ type: TaskDto })
  @ApiErrors(400, 401, 404, 409, 429, 500)
  claim(
    @Param('id') id: string,
    @Body() b: TaskContentBodyDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.claim(id, req.auth!, b);
  }

  @Post('tasks/:id/progress')
  @ApiOperation({
    operationId: 'reportTaskProgress',
    summary:
      'The doer reports progress with a progress_update naming the task. Counts as a reply (D-85).',
  })
  @ApiCreatedResponse({ type: TaskDto })
  @ApiErrors(400, 401, 403, 404, 409, 429, 500)
  progress(
    @Param('id') id: string,
    @Body() b: TaskContentBodyDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.progress(id, req.auth!, b);
  }

  @Patch('tasks/:id')
  @ApiOperation({
    operationId: 'updateTask',
    summary:
      'Doer, poster or steward: move a task on or drop it with a reason. Anyone but the doer: verify a done task.',
  })
  @ApiOkResponse({ type: TaskDto })
  @ApiErrors(400, 401, 403, 404, 409, 500)
  patch(
    @Param('id') id: string,
    @Body() b: PatchTaskBodyDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.patch(id, req.auth!, b);
  }

  @Post('tasks/:id/blockers')
  @ApiOperation({
    operationId: 'addTaskBlocker',
    summary: 'Doer, poster or steward: record what is in the way of a task',
  })
  @ApiCreatedResponse({ type: TaskDto })
  @ApiErrors(400, 401, 403, 404, 409, 500)
  addBlocker(
    @Param('id') id: string,
    @Body() b: AddBlockerBodyDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.addBlocker(id, req.auth!, b);
  }

  @Patch('tasks/:id/blockers/:blockerId')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'clearTaskBlocker',
    summary: 'Doer, poster or steward: mark a task blocker cleared',
  })
  @ApiOkResponse({ type: TaskDto })
  @ApiErrors(400, 401, 403, 404, 409, 500)
  clearBlocker(
    @Param('id') id: string,
    @Param('blockerId') blockerId: string,
    @Body() b: ClearBlockerBodyDto,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.clearBlocker(id, blockerId, req.auth!, b);
  }
}
