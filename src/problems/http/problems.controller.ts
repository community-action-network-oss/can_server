import { Controller, Get, Header, Inject, Param, Query } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, desc, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import { jurisdiction, problem } from '../../db/schema.js';
import {
  isPublicState,
  activeLabel,
  type ActiveStages,
  STATE_COPY,
  type State,
  STATES,
} from '../../domain/lifecycle/vocabulary.js';
import { ApiErrors, ApiException } from '../../platform/errors.js';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
} from '../../platform/pagination.js';
import { STAGE_CHIP, type StageChipPort } from '../app/stage-chip.port.js';
import {
  ListProblemsQueryDto,
  PublicProblemDto,
  PublicProblemPageDto,
} from './problems.dto.js';

type Row = typeof problem.$inferSelect;
const toDto = (
  r: Row,
  jurisdictionName: string | null,
  stages: ActiveStages,
): PublicProblemDto => ({
  id: r.id,
  title: r.title ?? '',
  state: r.state,
  label:
    r.state === 'active'
      ? activeLabel(stages)
      : STATE_COPY[r.state as State].label,
  jurisdiction: jurisdictionName,
  coarseArea: r.coarseArea,
  investigationNeeded: r.investigationNeeded,
  publishedAt: r.publishedAt!.toISOString(),
  // ponytail: no moderation run or reopen event exists yet; plan 09 / T20-T21 populate these.
  policyVersion: null,
  transitional: false,
  reopened: false,
  isSeed: r.isSeed,
  syntheticEvidence: r.syntheticEvidence,
  help_needed: r.helpNeeded,
});

const PUBLIC_STATES = STATES.filter((s) => isPublicState(s));
const UUID = /^[0-9a-f-]{36}$/i;

// Same answer for every caller: no session, no profile, no per-person variation (spec 26 section 4).
@ApiTags('problems')
@Controller('v1/problems')
export class ProblemsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STAGE_CHIP) private readonly chips: StageChipPort,
  ) {}

  private async shape(
    rows: { p: Row; j: string | null }[],
  ): Promise<PublicProblemDto[]> {
    const active = rows
      .filter((r) => r.p.state === 'active')
      .map((r) => r.p.id);
    const chips = active.length ? await this.chips.chips(active) : new Map();
    return rows.map((r) => toDto(r.p, r.j, chips.get(r.p.id) ?? null));
  }

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({
    operationId: 'listPublicProblems',
    summary:
      'Public problems, newest first, with help_needed; whole or by coarse region shard',
  })
  @ApiOkResponse({ type: PublicProblemPageDto })
  @ApiErrors(400, 429, 500)
  async list(@Query() q: ListProblemsQueryDto): Promise<PublicProblemPageDto> {
    const limit = clampLimit(q.limit);
    // Published, and never a pre-publication state; withdrawn only if it was public first (T18, OWN-1).
    const conds = [
      isNotNull(problem.publishedAt),
      or(
        inArray(problem.state, PUBLIC_STATES),
        and(
          eq(problem.state, 'withdrawn'),
          eq(problem.withdrawnPublished, true),
        ),
      )!,
    ];
    if (q.state) conds.push(eq(problem.state, q.state));
    if (q.jurisdictionId)
      conds.push(eq(problem.jurisdictionId, q.jurisdictionId));
    if (q.q)
      conds.push(
        sql`to_tsvector('simple', coalesce(${problem.title}, '') || ' ' || coalesce(${problem.condition}, '')) @@ plainto_tsquery('simple', ${q.q})`,
      );
    if (q.region)
      conds.push(sql`${problem.helpNeeded}->>'coarse_place' = ${q.region}`);
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
      conds.push(
        or(
          lt(problem.publishedAt, at),
          and(eq(problem.publishedAt, at), lt(problem.id, c.id)),
        )!,
      );
    }
    const rows = await this.db
      .select({ p: problem, j: jurisdiction.name })
      .from(problem)
      .leftJoin(jurisdiction, eq(jurisdiction.id, problem.jurisdictionId))
      .where(and(...conds))
      .orderBy(desc(problem.publishedAt), desc(problem.id))
      .limit(limit + 1);
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1]?.p;
    return {
      items: await this.shape(items),
      nextCursor:
        more && last
          ? encodeCursor({ at: last.publishedAt!.toISOString(), id: last.id })
          : null,
      criteria: { order: 'published_at_desc', usesEngagementSignals: false },
    };
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'getPublicProblem',
    summary: 'One public problem with help_needed',
  })
  @ApiOkResponse({ type: PublicProblemDto })
  @ApiErrors(404, 429, 500)
  async get(@Param('id') id: string): Promise<PublicProblemDto> {
    const [r] = UUID.test(id)
      ? await this.db
          .select({ p: problem, j: jurisdiction.name })
          .from(problem)
          .leftJoin(jurisdiction, eq(jurisdiction.id, problem.jurisdictionId))
          .where(eq(problem.id, id))
      : [];
    if (
      !r ||
      !r.p.publishedAt ||
      !isPublicState(r.p.state as State, r.p.withdrawnPublished)
    )
      throw new ApiException(404, 'not_found', 'Problem not found');
    return (await this.shape([r]))[0]!;
  }
}
