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
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import { problem } from '../../db/schema.js';
import { allowedTransitions } from '../../domain/lifecycle/guard.js';
import { TransitionEngine } from '../app/transition-engine.js';
import {
  isPublicState,
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
import { DraftMigrationService } from '../app/draft-migration.service.js';
import { DraftsService, EDITABLE } from '../app/drafts.service.js';
import {
  AllowedActionsDto,
  TransitionDto,
  TransitionResultDto,
  ConfirmMigrationDto,
  CreateDraftDto,
  DraftDto,
  MyProblemPageDto,
  MigrationPlanDto,
  MyProblemsQueryDto,
  UpdateDraftDto,
} from './drafts.dto.js';

const DAY = 86_400_000;
const CREATE_PER_DAY = 20;
const UUID = /^[0-9a-f-]{36}$/i;
// Initiator withdrawal before publication (T06, T07). Withdrawing an active problem (T18) needs a contribution check, so not offered here.
const WITHDRAWABLE = ['in_review', 'held', 'needs_revision'];
// Flipped (by deleting this) by the unit that wires the submit checks; until then T01 and T03 stay refused.
const SUBMIT_CHECKS_WIRED: boolean = false;
// T00 and T19 are the draft create and delete routes above, not moves through the engine.
const NOT_VIA_ENGINE = ['T00', 'T19'];
const uid = (id: string) => {
  if (!UUID.test(id))
    throw new ApiException(404, 'not_found', 'Problem not found');
  return id;
};

const stampDto = (s: {
  schemaId: string;
  schemaVersion: string;
  schemaHash: string;
}) => ({
  schema_id: s.schemaId,
  schema_version: s.schemaVersion,
  schema_hash: s.schemaHash,
});

// Separate prefixes on purpose: /v1/problems* is pinned to 3 public GETs (PROFILE-LOCAL-1).
@ApiTags('drafts')
@Controller('v1/drafts')
export class DraftsController {
  constructor(
    @Inject(DraftsService) private readonly drafts: DraftsService,
    @Inject(DraftMigrationService)
    private readonly migration: DraftMigrationService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(DB) private readonly db: Db,
    @Inject(TransitionEngine) private readonly engine: TransitionEngine,
    @Inject(STAGE_CHIP) private readonly chips: StageChipPort,
  ) {}

  /** Own problem, or a public one. Anything else is a 404 so private existence never leaks. */
  private async visible(id: string, accountId?: string) {
    const [r] = await this.db
      .select()
      .from(problem)
      .where(eq(problem.id, uid(id)));
    const own = !!accountId && r?.initiatorId === accountId;
    const open =
      !!r?.publishedAt && isPublicState(r.state as State, r.withdrawnPublished);
    if (!r || r.deletedAt || !(own || open))
      throw new ApiException(404, 'not_found', 'Problem not found');
    return { r, own };
  }

  private async label(id: string, state: string) {
    if (state !== 'active') return STATE_COPY[state as State].label;
    return activeLabel((await this.chips.chips([id])).get(id) ?? null);
  }

  @Post(':id/transitions')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'transitionProblem',
    summary:
      'Move your problem to another state, or propose a move that a recorded check decides',
  })
  @ApiOkResponse({ type: TransitionResultDto })
  @ApiErrors(400, 401, 403, 404, 409, 429, 500)
  async transition(
    @Param('id') id: string,
    @Body() body: TransitionDto,
    @Req() req: AuthedRequest,
  ): Promise<TransitionResultDto> {
    const a = req.auth!;
    const { r, own } = await this.visible(id, a.accountId);
    if (!own)
      throw new ApiException(403, 'not_permitted', 'You cannot do that.');
    if (!SUBMIT_CHECKS_WIRED && body.to === 'in_review')
      throw new ApiException(403, 'not_permitted', 'checks not wired');
    const res = await this.engine.apply({
      problemId: r.id,
      to: body.to,
      actor: { kind: 'initiator', id: a.accountId },
      fields: body.fields,
      reason: body.reason,
      action: body.action,
      expectedVersion: body.expectedVersion,
    });
    return {
      id: r.id,
      state: res.state,
      label: await this.label(r.id, res.state),
      version: res.version,
      pending:
        body.action === 'propose'
          ? { to: body.to, proposedBy: a.handle }
          : null,
    };
  }

  @Get(':id/actions')
  @ApiOperation({
    operationId: 'getProblemActions',
    summary: 'Which moves you may try on this problem right now',
  })
  @ApiOkResponse({ type: AllowedActionsDto })
  @ApiErrors(404, 429, 500)
  async actions(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<AllowedActionsDto> {
    const { r, own } = await this.visible(id, req.auth?.accountId);
    const actions = own
      ? allowedTransitions(r.state as State, 'initiator')
          .filter(
            (t) =>
              !NOT_VIA_ENGINE.includes(t.id) &&
              (SUBMIT_CHECKS_WIRED || t.to !== 'in_review'),
          )
          .map((t) => ({
            to: t.to === 'same' ? r.state : t.to,
            requires: [...t.required],
            mode: t.proposedBy.includes('initiator') ? 'propose' : 'direct',
          }))
      : [];
    return { state: r.state, version: r.version, actions };
  }

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

  @Get(':id/migration')
  @Authenticated()
  @ApiOperation({
    operationId: 'getDraftMigration',
    summary:
      'What moving this draft to the current form would carry over; minor and patch changes migrate on this call',
  })
  @ApiOkResponse({ type: MigrationPlanDto })
  @ApiErrors(401, 404, 409, 429, 500)
  async migrationPlan(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<MigrationPlanDto> {
    const v = await this.migration.preview(req.auth!.accountId, uid(id));
    return {
      state: v.state,
      bump: v.bump,
      current: stampDto(v.current),
      target: stampDto(v.target),
      grace_ends_at: v.graceEndsAt?.toISOString() ?? null,
      mapping: v.mapping,
      new_required: v.newRequired,
      dropped: v.dropped,
    };
  }

  @Post(':id/migration')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'confirmDraftMigration',
    summary:
      'Move this draft to the current form with the mappings you confirmed',
  })
  @ApiOkResponse({ type: DraftDto })
  @ApiErrors(400, 401, 403, 404, 409, 429, 500)
  confirmMigration(
    @Param('id') id: string,
    @Body() body: ConfirmMigrationDto,
    @Req() req: AuthedRequest,
  ): Promise<DraftDto> {
    return this.migration.confirm(
      req.auth!.accountId,
      uid(id),
      body.expectedVersion,
      body.mappings,
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
