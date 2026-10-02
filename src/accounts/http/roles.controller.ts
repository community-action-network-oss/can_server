import { Controller, Get, Inject, Req } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrors } from '../../platform/errors.js';
import type { AuthedRequest } from '../../platform/security/auth.guard.js';
import { Authenticated } from '../../platform/security/decorators.js';
import { HUMAN_ROLES, RoleService } from '../app/roles.js';

export class MyRolesDto {
  @ApiProperty({ enum: HUMAN_ROLES, isArray: true }) roles!: string[];
}

@ApiTags('accounts')
@Controller('v1/me/roles')
export class RolesController {
  constructor(@Inject(RoleService) private readonly roles: RoleService) {}

  @Get()
  @Authenticated()
  @ApiOperation({
    operationId: 'getMyRoles',
    summary: 'Your active human roles (auditor, labeler, lane_member, steward)',
  })
  @ApiOkResponse({ type: MyRolesDto })
  @ApiErrors()
  async mine(@Req() req: AuthedRequest): Promise<MyRolesDto> {
    return { roles: await this.roles.rolesOf(req.auth!.accountId) };
  }
}
