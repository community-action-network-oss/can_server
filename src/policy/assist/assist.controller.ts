import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrors, ApiException } from '../../platform/errors.js';
import type { AuthedRequest } from '../../platform/security/auth.guard.js';
import { AssistRequestDto, AssistResponseDto } from './assist.dto.js';
import { AssistService } from './assist.service.js';

const UUID = /^[0-9a-f-]{36}$/i;

// Owner-scoped under /v1/drafts: /v1/problems* stays three public GETs (PROFILE-LOCAL-1).
@ApiTags('drafts')
@Controller('v1/drafts')
export class AssistController {
  constructor(@Inject(AssistService) private readonly assist: AssistService) {}

  @Post(':id/assist')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'assistDraftFill',
    summary:
      'Suggest values for fields from your private notes. Proposals only; you accept each one. 503 assist_unavailable when no assistant is configured',
  })
  @ApiOkResponse({ type: AssistResponseDto })
  @ApiErrors(400, 401, 404, 429, 500, 503)
  run(
    @Param('id') id: string,
    @Body() body: AssistRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<AssistResponseDto> {
    if (!UUID.test(id))
      throw new ApiException(404, 'not_found', 'Problem not found');
    return this.assist.run(req.auth!.accountId, id, body);
  }
}
