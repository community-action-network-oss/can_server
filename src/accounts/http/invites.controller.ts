import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors, ApiException } from '../../platform/errors.js';
import type { AuthedRequest } from '../../platform/security/auth.guard.js';
import { Authenticated, Roles } from '../../platform/security/decorators.js';
import {
  RATE_LIMITER,
  type RateLimiter,
} from '../../platform/security/rate-limiter.js';
import { InviteService } from '../app/invite.service.js';
import {
  InviteIssuedDto,
  InviteListItemDto,
  IssueInviteDto,
} from './invites.dto.js';

const DAY = 86_400_000;
const DAILY_LIMIT = 20;

/** "Steward" is the moderator role; admins may issue too. */
@ApiTags('invites')
@Controller('v1/invites')
export class InvitesController {
  constructor(
    @Inject(InviteService) private readonly invites: InviteService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  @Post()
  @HttpCode(201)
  @Roles('moderator', 'admin')
  @ApiOperation({
    operationId: 'issueInvite',
    summary: 'Issue a one-time invite code (shown once, stored only as a hash)',
  })
  @ApiCreatedResponse({ type: InviteIssuedDto })
  @ApiErrors()
  async issue(
    @Body() body: IssueInviteDto,
    @Req() req: AuthedRequest,
  ): Promise<InviteIssuedDto> {
    const { accountId } = req.auth!;
    if (!(await this.limiter.hit(`invite:${accountId}`, DAILY_LIMIT, DAY)))
      throw new ApiException(
        429,
        'rate_limited',
        'You have issued enough invites for today.',
      );
    return this.invites.issue(accountId, body.expiresInDays ?? 14);
  }

  @Get()
  @Authenticated()
  @Roles('moderator', 'admin')
  @ApiOperation({
    operationId: 'listInvites',
    summary: 'Invites you issued, without their codes',
  })
  @ApiOkResponse({ type: [InviteListItemDto] })
  @ApiErrors()
  list(@Req() req: AuthedRequest): Promise<InviteListItemDto[]> {
    return this.invites.list(req.auth!);
  }
}
