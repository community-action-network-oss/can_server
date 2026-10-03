import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors } from '../platform/errors.js';
import { clampLimit } from '../platform/pagination.js';
import type { AuthedRequest } from '../platform/security/auth.guard.js';
import { Authenticated } from '../platform/security/decorators.js';
import {
  FollowDto,
  FollowListDto,
  FollowRequestDto,
  NotificationPageDto,
} from './follows.dto.js';
import { FollowsService } from './follows.service.js';

/** Owner routes only (NOT /v1/problems*). Signed in is the default for non-GET; the GETs read req.auth. */
@ApiTags('follows')
@Controller('v1')
export class FollowsController {
  constructor(@Inject(FollowsService) private readonly svc: FollowsService) {}

  @Post('follows')
  @ApiOperation({
    operationId: 'followProblem',
    summary:
      'Follow a public problem on purpose; optionally opt in to update emails',
  })
  @ApiCreatedResponse({ type: FollowDto })
  @ApiErrors(400, 401, 404, 500)
  follow(@Body() b: FollowRequestDto, @Req() req: AuthedRequest) {
    return this.svc.follow(req.auth!.accountId, b.problemId, b.emailUpdates);
  }

  @Delete('follows/:problemId')
  @HttpCode(204)
  @ApiOperation({
    operationId: 'unfollowProblem',
    summary: 'Unfollow a problem',
  })
  @ApiNoContentResponse()
  @ApiErrors(400, 401, 500)
  async unfollow(
    @Param('problemId', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ) {
    await this.svc.unfollow(req.auth!.accountId, id);
  }

  @Post('follows/:problemId/mute')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'muteFollow',
    summary: 'Mute a follow: it stays, nothing is sent',
  })
  @ApiOkResponse({ type: FollowDto })
  @ApiErrors(400, 401, 404, 500)
  mute(
    @Param('problemId', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.mute(req.auth!.accountId, id, true);
  }

  @Post('follows/:problemId/unmute')
  @HttpCode(200)
  @ApiOperation({ operationId: 'unmuteFollow', summary: 'Unmute a follow' })
  @ApiOkResponse({ type: FollowDto })
  @ApiErrors(400, 401, 404, 500)
  unmute(
    @Param('problemId', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ) {
    return this.svc.mute(req.auth!.accountId, id, false);
  }

  @Delete('me/follows/email-consent')
  @HttpCode(204)
  @ApiOperation({
    operationId: 'revokeFollowEmailConsent',
    summary:
      'Withdraw consent for update emails; follows and in-app items stay',
  })
  @ApiNoContentResponse()
  @ApiErrors(401, 500)
  async revoke(@Req() req: AuthedRequest) {
    await this.svc.revokeEmailConsent(req.auth!.accountId);
  }

  @Get('me/follows')
  @Authenticated()
  @ApiOperation({
    operationId: 'listMyFollows',
    summary: 'Problems you follow',
  })
  @ApiOkResponse({ type: FollowListDto })
  @ApiErrors(401, 500)
  mine(@Req() req: AuthedRequest) {
    return this.svc.mine(req.auth!.accountId);
  }

  @Get('me/notifications')
  @Authenticated()
  @ApiOperation({
    operationId: 'listMyNotifications',
    summary: 'Your notifications, newest first. No counts, no badge data',
  })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ type: NotificationPageDto })
  @ApiErrors(400, 401, 500)
  list(
    @Req() req: AuthedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.notifications(
      req.auth!.accountId,
      clampLimit(limit),
      cursor,
    );
  }

  @Post('me/notifications/read-all')
  @HttpCode(204)
  @ApiOperation({
    operationId: 'readAllMyNotifications',
    summary: 'Mark all notifications read',
  })
  @ApiNoContentResponse()
  @ApiErrors(401, 500)
  async readAll(@Req() req: AuthedRequest) {
    await this.svc.readAll(req.auth!.accountId);
  }

  @Post('me/notifications/:id/read')
  @HttpCode(204)
  @ApiOperation({
    operationId: 'readMyNotification',
    summary: 'Mark one notification read',
  })
  @ApiNoContentResponse()
  @ApiErrors(400, 401, 404, 500)
  async read(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ) {
    await this.svc.markRead(req.auth!.accountId, id);
  }
}
