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
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  activeLabel,
  STATE_COPY,
  type State,
} from '../../domain/lifecycle/vocabulary.js';
import { ApiErrors, ApiException } from '../../platform/errors.js';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
} from '../../platform/pagination.js';
import type { AuthedRequest } from '../../platform/security/auth.guard.js';
import { Authenticated } from '../../platform/security/decorators.js';
import {
  RATE_LIMITER,
  type RateLimiter,
} from '../../platform/security/rate-limiter.js';
import { STAGE_CHIP, type StageChipPort } from '../app/stage-chip.port.js';
import { DraftsService, EDITABLE } from '../app/drafts.service.js';
import {
  CreateDraftDto,
  DraftDto,
  MyProblemPageDto,
  MyProblemsQueryDto,
  UpdateDraftDto,
} from './drafts.dto.js';

const DAY = 86_400_000;
const CREATE_PER_DAY = 20;
const UUID = /^[0-9a-f-]{36}$/i;
// Initiator withdrawal before publication (T06, T07). Withdrawing an active problem (T18) needs a contribution check, so not offered here.
const WITHDRAWABLE = ['in_review', 'held', 'needs_revision'];
const uid = (id: string) => {
  if (!UUID.test(id))
    throw new ApiException(404, 'not_found', 'Problem not found');
  return id;
};

// Separate prefixes on purpose: /v1/problems* is pinned to 3 public GETs (PROFILE-LOCAL-1).
@ApiTags('drafts')
@Controller('v1/drafts')
export class DraftsController {
  constructor(
    @Inject(DraftsService) private readonly drafts: DraftsService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  @Post()
  @ApiOperation({
    operationId: 'createDraft',
    summary: 'Start a private draft (T00)',
  })
  @ApiCreatedResponse({ type: DraftDto })
  @ApiErrors(400, 401, 403, 429, 500)
  async create(
    @Body() body: CreateDraftDto,
    @Req() req: AuthedRequest,
  ): Promise<DraftDto> {
    const a = req.auth!.accountId;
    if (!(await this.limiter.hit(`draft:${a}`, CREATE_PER_DAY, DAY)))
      throw new ApiException(
        429,
        'rate_limited',
        'Too many drafts today. Try again tomorrow.',
      );
    const { content, schemaVersion, schemaHash, ...fields } = body;
    return this.drafts.create(a, fields, {
      content,
      schemaVersion,
      schemaHash,
    });
  }

  @Patch(':id')
  @ApiOperation({
    operationId: 'updateDraft',
    summary:
      'Edit your problem while it is a draft, needs changes or in review',
  })
  @ApiOkResponse({ type: DraftDto })
  @ApiErrors(400, 401, 403, 404, 409, 429, 500)
  update(
    @Param('id') id: string,
    @Body() body: UpdateDraftDto,
    @Req() req: AuthedRequest,
  ): Promise<DraftDto> {
    const { expectedVersion, content, schemaVersion, schemaHash, ...fields } =
      body;
    return this.drafts.update(
      req.auth!.accountId,
      uid(id),
      fields,
      expectedVersion,
      { content, schemaVersion, schemaHash },
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    operationId: 'deleteDraft',
    summary: 'Discard your draft (T19)',
  })
  @ApiNoContentResponse()
  @ApiErrors(401, 403, 404, 409, 429, 500)
  async remove(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    await this.drafts.remove(req.auth!.accountId, uid(id));
  }
}

@ApiTags('drafts')
@Controller('v1/me/problems')
export class MyProblemsController {
  constructor(
    @Inject(DraftsService) private readonly drafts: DraftsService,
    @Inject(STAGE_CHIP) private readonly chips: StageChipPort,
  ) {}

  @Get()
  @Authenticated()
  @ApiOperation({
    operationId: 'listMyProblems',
    summary: 'Your own problems, newest first, with the exact deletion date',
  })
  @ApiOkResponse({ type: MyProblemPageDto })
  @ApiErrors(400, 401, 429, 500)
  async list(
    @Query() q: MyProblemsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<MyProblemPageDto> {
    const limit = clampLimit(q.limit);
    let cursor: { at: Date; id: string } | undefined;
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      const at = typeof c.at === 'string' ? new Date(c.at) : null;
      if (
        !at ||
        isNaN(at.getTime()) ||
        typeof c.id !== 'string' ||
        !UUID.test(c.id)
      )
        throw new ApiException(400, 'validation_failed', 'Invalid cursor', {
          cursor: 'Invalid cursor',
        });
      cursor = { at, id: c.id };
    }
    const rows = await this.drafts.mine(req.auth!.accountId, limit, cursor);
    const items = rows.slice(0, limit);
    const active = items.filter((r) => r.state === 'active').map((r) => r.id);
    const chips = active.length ? await this.chips.chips(active) : new Map();
    const last = items[items.length - 1];
    return {
      items: items.map((r) => ({
        id: r.id,
        state: r.state,
        label:
          r.state === 'active'
            ? activeLabel(chips.get(r.id) ?? null)
            : STATE_COPY[r.state as State].label,
        title: r.title,
        updatedAt: r.updatedAt.toISOString(),
        deleteAfter: r.purgeAfter?.toISOString() ?? null,
        appealableUntil: null, // ponytail: filled by the moderation unit
        canWithdraw: WITHDRAWABLE.includes(r.state),
        canEdit: EDITABLE.includes(r.state),
        reviewCount: 0, // ponytail: 12-u03 fills these
        needsReviewers: false,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ at: last.updatedAt.toISOString(), id: last.id })
          : null,
    };
  }
}
