import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors } from '../../platform/errors.js';
import type { AuthedRequest } from '../../platform/security/auth.guard.js';
import { Authenticated } from '../../platform/security/decorators.js';
import { ReplyAllowanceService } from '../app/reply-cap.js';

export class ReplyAllowanceDto {
  @ApiProperty() limit!: number;
  @ApiProperty() remaining!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'ISO time the next slot frees',
  })
  resetsAt!: string | null;
}

// Not under /v1/problems (pinned to 3 public GETs, PROFILE-LOCAL-1).
@ApiTags('contributions')
@Controller('v1/me/problems')
export class ReplyAllowanceController {
  constructor(
    @Inject(ReplyAllowanceService) private readonly svc: ReplyAllowanceService,
  ) {}

  @Get(':id/reply-allowance')
  @Authenticated()
  @ApiOperation({
    operationId: 'getMyReplyAllowance',
    summary:
      'How many replies you have left on this problem in the rolling window (for "2 of 4 replies left today")',
  })
  @ApiOkResponse({ type: ReplyAllowanceDto })
  @ApiErrors(401, 404, 500)
  get(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.svc.get(req.auth!.accountId, id);
  }
}
