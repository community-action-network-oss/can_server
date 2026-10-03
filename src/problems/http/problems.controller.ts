import { allowedTypes } from '../../contributions/domain/allowed.js';
import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, asc, desc, eq, gt, isNotNull, lt, or, sql } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import {
  acceptanceCriterion,
  account,
  jurisdiction,
  problem,
  problemEvent,
  sourceRef,
} from '../../db/schema.js';
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
import type { AuthedRequest } from '../../platform/security/auth.guard.js';
import type { AuthContext } from '../../platform/security/decorators.js';
import { STAGE_CHIP, type StageChipPort } from '../app/stage-chip.port.js';
import {
  EventsQueryDto,
  ListProblemsQueryDto,
  ProblemDetailDto,
  ProblemEventPageDto,
  PublicProblemDto,
  PublicProblemPageDto,
} from './problems.dto.js';

type Row = typeof problem.$inferSelect;
const CATEGORY_LABEL: Record<string, string> = {
  official_record: 'Official record',
  statistics_body: 'Statistics body',
  court_or_legislature: 'Court or legislature',
  reputable_media: 'Reputable media',
  research: 'Research',
  civil_society: 'Civil society',
  other: 'Other',
};
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
  publishedAt: r.publishedAt?.toISOString() ?? '',
  // ponytail: no moderation run or reopen event exists yet; plan 09 / T20-T21 populate these.
  policyVersion: null,
  transitional: false,
  reopened: false,
  isSeed: r.isSeed,
  syntheticEvidence: r.syntheticEvidence,
  help_needed: r.helpNeeded,
});

const PUBLIC_STATES = STATES.filter((s) => isPublicState(s));
// Event types whose actor handle is public. Everything else shows no actor (default; widen with plan 03).
const PUBLIC_ACTOR_EVENTS = new Set([
  'published',
  'solved',
  'closed',
  'redirected',
  'reopened',
]);
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

  /** Public rule, or the initiator's own problem. Otherwise 404, so private existence never leaks. */
  private async visible(id: string, auth?: AuthContext) {
    const [r] = UUID.test(id)
      ? await this.db
          .select({ p: problem, j: jurisdiction.name, h: account.handle })
          .from(problem)
          .leftJoin(jurisdiction, eq(jurisdiction.id, problem.jurisdictionId))
          .leftJoin(account, eq(account.id, problem.initiatorId))
          .where(eq(problem.id, id))
      : [];
    const isPublic =
      !!r?.p.publishedAt &&
      isPublicState(r.p.state as State, r.p.withdrawnPublished);
    const own =
      !!auth && !!r?.p.initiatorId && r.p.initiatorId === auth.accountId;
    if (!r || r.p.deletedAt || !(isPublic || own))
      throw new ApiException(404, 'not_found', 'Problem not found');
    return r;
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-cache')
  @ApiOperation({
    operationId: 'getPublicProblem',
    summary:
      'One problem: public after publish, tombstone for withdrawn items, private drafts only to the initiator',
  })
  @ApiOkResponse({ type: ProblemDetailDto })
  @ApiErrors(404, 429, 500)
  async get(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<ProblemDetailDto> {
    const { p, j, h } = await this.visible(id, req.auth);
    const state = p.state as State;
    const copy = STATE_COPY[state];
    const stages = (await this.shape([{ p, j }]))[0]!;
    const tomb = p.tombstonedAt;
    const [t] = tomb
      ? await this.db
          .select({ reason: problemEvent.reason })
          .from(problemEvent)
          .where(
            and(
              eq(problemEvent.problemId, p.id),
              eq(problemEvent.type, 'tombstoned'),
            ),
          )
          .orderBy(desc(problemEvent.occurredAt))
          .limit(1)
      : [];
    const text = (v: string | null) => (tomb ? null : v);
    // Sources and final criteria are public only once published; a draft owner reads them through the preparation routes.
    const open =
      !tomb && !!p.publishedAt && isPublicState(state, p.withdrawnPublished);
    const sources = open
      ? await this.db
          .select()
          .from(sourceRef)
          .where(eq(sourceRef.problemId, p.id))
          .orderBy(asc(sourceRef.ordinal))
      : [];
    const criteria = open
      ? await this.db
          .select()
          .from(acceptanceCriterion)
          .where(eq(acceptanceCriterion.problemId, p.id))
          .orderBy(asc(acceptanceCriterion.ordinal))
      : [];
    return {
      id: p.id,
      state: p.state,
      label: stages.label,
      explanation: copy.explanation
        .replace('[reason]', p.pauseReason ?? '[reason]')
        .replace('[condition]', p.resumeCondition ?? '[condition]'),
      nextAction: copy.nextAction,
      policyVersion: stages.policyVersion,
      transitional: stages.transitional,
      reopened: stages.reopened,
      title: text(p.title),
      condition: text(p.condition),
      affected: text(p.affected),
      coarseArea: p.coarseArea,
      observed: text(p.observed),
      uncertain: text(p.uncertain),
      desiredOutcome: text(p.desiredOutcome),
      jurisdiction: j,
      investigationNeeded: p.investigationNeeded,
      publishedAt: p.publishedAt?.toISOString() ?? null,
      authorHandle: h,
      pauseReason: text(p.pauseReason),
      resumeCondition: text(p.resumeCondition),
      duplicateOf: p.duplicateOf,
      // ponytail: no review table yet (12-u03); the count is always 0 until it lands.
      reviewCount: 0,
      sources: sources.map((x) => ({
        uri: x.uri,
        category: x.category,
        categoryLabel: CATEGORY_LABEL[x.category] ?? x.category,
        establishes: x.establishes,
      })),
      finalCriteria: criteria.map((c, i) => ({
        ref: i + 1,
        statement: c.statement,
        measure: c.measure,
        deadline: c.deadline,
      })),
      planVersion: open ? p.planVersion : null,
      isSeed: p.isSeed,
      syntheticEvidence: p.syntheticEvidence,
      help_needed: p.helpNeeded,
      allowedContributionTypes:
        req.auth && !tomb
          ? [...allowedTypes({ problemState: state, stageState: null })]
          : [],
      tombstone: tomb
        ? {
            tombstone: true,
            tombstonedAt: tomb.toISOString(),
            reason: t?.reason ?? null,
          }
        : null,
    };
  }

  @Get(':id/events')
  @Header('Cache-Control', 'private, no-cache')
  @ApiOperation({
    operationId: 'listProblemEvents',
    summary:
      'Timeline of a visible problem, oldest first; payloads are never returned',
  })
  @ApiOkResponse({ type: ProblemEventPageDto })
  @ApiErrors(400, 404, 429, 500)
  async events(
    @Param('id') id: string,
    @Query() q: EventsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<ProblemEventPageDto> {
    const { p } = await this.visible(id, req.auth);
    const limit = clampLimit(q.limit);
    const conds = [eq(problemEvent.problemId, p.id)];
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
          gt(problemEvent.occurredAt, at),
          and(eq(problemEvent.occurredAt, at), gt(problemEvent.id, c.id)),
        )!,
      );
    }
    const rows = await this.db
      .select({ e: problemEvent, h: account.handle })
      .from(problemEvent)
      .leftJoin(account, eq(account.id, problemEvent.actorId))
      .where(and(...conds))
      .orderBy(asc(problemEvent.occurredAt), asc(problemEvent.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit);
    const last = items[items.length - 1]?.e;
    return {
      items: items.map(({ e, h }) => ({
        id: e.id,
        type: e.type,
        fromState: e.fromState,
        toState: e.toState,
        reason: p.tombstonedAt ? null : e.reason,
        occurredAt: e.occurredAt.toISOString(),
        actor: PUBLIC_ACTOR_EVENTS.has(e.type) ? h : null,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ at: last.occurredAt.toISOString(), id: last.id })
          : null,
    };
  }
}
