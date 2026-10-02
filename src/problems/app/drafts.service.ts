import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { config } from '../../config.js';
import { DB, type Db } from '../../db/db.module.js';
import {
  acceptanceCriterion,
  jurisdiction,
  problem,
  problemEvent,
  sourceRef,
  stage,
  stageEdge,
} from '../../db/schema.js';
import { withTransaction, type Tx } from '../../db/tx.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';
import { AuditPort } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import {
  StructuredContentService,
  schemaError,
  type SchemaStamp,
} from '../../policy/app/structured-content.service.js';
import {
  ContentSchemaNotFound,
  PolicyUnavailable,
} from '../../policy/domain/pack.js';
import {
  planFromWire,
  planToWire,
  type PlanDraft,
  type StageDraft,
  type WireFinalCriterion,
  type WireStageNode,
} from '../../stages/app/plan-wire.js';
import { DrizzleStagePlanRepo } from '../../stages/infra/stage-plan.repo.js';
import { StagePlanService } from '../../stages/app/stage-plan.service.js';
import { CLASSIC_5, ONE_STAGE } from '../../stages/domain/templates.js';
import {
  changedPaths,
  checkPlan,
  insecureSources,
  partOf,
  type Errors,
} from '../domain/preparation.js';
import { assess, violations } from './preparation.js';
import { preparationEffects } from './preparation-effects.js';
import { SubmitChecks } from './submit-checks.service.js';
import { TransitionEffects } from './transition-ports.js';
import { DraftMigrationService } from './draft-migration.service.js';
import { pin, stampOf } from './schema-stamp.js';
import { checkLimits, type LimitField } from '../domain/eligibility/limits.js';

export const EDITABLE = ['draft', 'needs_revision', 'in_review'];
const FIELDS = [
  'title',
  'condition',
  'affected',
  'coarseArea',
  'desiredOutcome',
  'observed',
  'uncertain',
  'jurisdictionId',
] as const;
export type DraftInput = Partial<Record<(typeof FIELDS)[number], string>>;

/** The structured part of a draft body: validated against the schema version stamped on the draft. */
export interface StructuredInput {
  content?: Record<string, unknown>;
  schemaVersion?: string;
  schemaHash?: string;
  /** Envelope fields (camelCase); their items stay snake_case content (D-82) and are merged into `content`. */
  sources?: Record<string, unknown>[];
  finalAcceptanceCriteria?: Record<string, unknown>[];
  /** The "no source yet" case: the problem is then marked needs evidence. */
  noSourceNote?: string;
}

export interface StagePlanInput {
  template?: 'classic-5' | 'one-stage' | null;
  stages?: Record<string, unknown>[];
  edges?: { from: string; to: string }[];
}

const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
/** The body's content with the envelope fields folded in; undefined when the request carried none of them. */
const mergeContent = (
  base: Record<string, unknown> | null,
  st: StructuredInput,
): Record<string, unknown> | undefined =>
  st.content || st.sources || st.finalAcceptanceCriteria
    ? {
        ...(st.content ?? base),
        ...(st.sources ? { sources: st.sources } : null),
        ...(st.finalAcceptanceCriteria
          ? { final_acceptance_criteria: st.finalAcceptanceCriteria }
          : null),
      }
    : undefined;
const insecure = (content: Record<string, unknown> | undefined) => {
  const errs = insecureSources(content?.sources);
  if (Object.keys(errs).length)
    throw new ApiException(
      400,
      'validation_failed',
      'Some sources need attention.',
      errs,
    );
};
const PLAN_STATES = ['draft', 'needs_revision'];
const SOURCE_CATEGORIES = [
  'official_record',
  'statistics_body',
  'court_or_legislature',
  'reputable_media',
  'research',
  'civil_society',
  'other',
];
const SCHEMA_TYPE = 'problem';
const unavailable = () =>
  new ApiException(503, 'policy_unavailable', 'Policy is not available.');

const notFound = () => new ApiException(404, 'not_found', 'Problem not found');

@Injectable()
export class DraftsService {
  private readonly plans: DrizzleStagePlanRepo;
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(AuditPort) private readonly audit: AuditPort,
    @Inject(StructuredContentService)
    private readonly structured: StructuredContentService,
    @Inject(DraftMigrationService)
    private readonly migration: DraftMigrationService,
    @Inject(SubmitChecks) private readonly checks: SubmitChecks,
    @Inject(TransitionEffects) effects: TransitionEffects,
  ) {
    this.plans = new DrizzleStagePlanRepo(db);
    // 12-u04 hooks on T01, T04, T05, T06 and T07. The review module binds REVIEW_HOOKS; until then they do nothing.
    for (const e of preparationEffects(
      new StagePlanService(ids),
      () => this.checks.hooks,
    ))
      effects.register(e);
  }

  /** Never put content in events: only the names of changed fields. */
  private event(
    tx: Tx,
    problemId: string,
    type: string,
    actorId: string,
    from: string | null,
    to: string | null,
    payload: Record<string, unknown>,
  ) {
    return tx.insert(problemEvent).values({
      id: this.ids.next(),
      problemId,
      type,
      actorId,
      fromState: from,
      toState: to,
      payload,
      prevHash: null,
      originNodeId: config.nodeId,
      protocolVersion: PROTOCOL_VERSION,
      occurredAt: this.clock.now(),
    });
  }

  private async validate(tx: Tx, input: DraftInput) {
    const errs: Record<string, string> = {};
    for (const v of checkLimits(input as Partial<Record<LimitField, string>>)
      .violations)
      errs[v.field] = `Use at most ${v.max} characters.`;
    if (input.jurisdictionId) {
      const [j] = await tx
        .select({ id: jurisdiction.id })
        .from(jurisdiction)
        .where(eq(jurisdiction.id, input.jurisdictionId));
      if (!j) errs.jurisdictionId = 'Unknown jurisdiction.';
    }
    if (Object.keys(errs).length)
      throw new ApiException(
        400,
        'validation_failed',
        'Some fields are too long or invalid.',
        errs,
      );
  }

  /** T00: no row exists to run through the engine, so the row and its event are written here in one transaction. */
  async create(accountId: string, input: DraftInput, st: StructuredInput = {}) {
    const id = this.ids.next();
    const now = this.clock.now();
    let stamp: SchemaStamp | null = null;
    const content = mergeContent(null, st);
    insecure(content);
    await withTransaction(this.db, async (tx) => {
      await this.validate(tx, input);
      const wants = !!(content || st.schemaVersion || st.schemaHash);
      try {
        stamp = await this.structured.stamp(tx, SCHEMA_TYPE, now, {
          version: st.schemaVersion,
          hash: st.schemaHash,
        });
      } catch (e) {
        // Without an active pack a plain draft still saves (legacy, unstamped); a structured one cannot.
        if (
          !(
            e instanceof PolicyUnavailable || e instanceof ContentSchemaNotFound
          ) ||
          wants
        )
          throw e instanceof PolicyUnavailable ? unavailable() : e;
      }
      if (content && stamp)
        await this.structured.validate(
          tx,
          SCHEMA_TYPE,
          stamp,
          content,
          'draft',
        );
      await tx.insert(problem).values({
        id,
        initiatorId: accountId,
        state: 'draft',
        ...input,
        ...stamp,
        content: content ?? null,
        noSourceNote: st.noSourceNote || null,
        jurisdictionId: input.jurisdictionId ?? null,
        helpNeeded: {
          skill_groups: [],
          languages: [],
          coarse_place: null,
          topics: [],
        },
        originNodeId: config.nodeId,
        protocolVersion: PROTOCOL_VERSION,
        createdAt: now,
        updatedAt: now,
      });
      if (content) await this.syncSources(tx, id, content.sources);
      await this.event(tx, id, 'draft_created', accountId, null, 'draft', {
        transitionId: 'T00',
      });
    });
    return {
      id,
      state: 'draft',
      version: 1,
      updatedAt: now.toISOString(),
      ...pin(stamp),
    };
  }

  private async lock(tx: Tx, id: string, accountId: string) {
    const [r] = await tx
      .select()
      .from(problem)
      .where(eq(problem.id, id))
      .for('update');
    if (!r || r.initiatorId !== accountId || r.deletedAt) throw notFound();
    return r;
  }

  /** Author only; anyone else, and deleted drafts, get the same 404. */
  async get(accountId: string, id: string) {
    const [r] = await this.db.select().from(problem).where(eq(problem.id, id));
    if (!r || r.initiatorId !== accountId || r.deletedAt) throw notFound();
    return {
      id: r.id,
      state: r.state,
      version: r.version,
      updatedAt: r.updatedAt.toISOString(),
      ...pin(stampOf(r)),
      content: (r.content as Record<string, unknown> | null) ?? null,
    };
  }

  async update(
    accountId: string,
    id: string,
    input: DraftInput,
    expectedVersion: number,
    st: StructuredInput = {},
  ) {
    const now = this.clock.now();
    return withTransaction(this.db, async (tx) => {
      let r = await this.lock(tx, id, accountId);
      if (!EDITABLE.includes(r.state))
        throw new ApiException(
          409,
          'invalid_transition',
          'This problem can no longer be edited.',
        );
      if (r.version !== expectedVersion)
        throw new ApiException(
          409,
          'conflict',
          'The problem changed; reload and retry.',
        );
      await this.validate(tx, input);
      // Minor and patch bumps move the draft along; a content edit after the major grace window must migrate first.
      r = await this.migration.beforeWrite(tx, r, {
        content: !!(st.content || st.sources || st.finalAcceptanceCriteria),
      });
      const content = mergeContent(
        r.content as Record<string, unknown> | null,
        st,
      );
      insecure(content);
      // The body is checked against the version stamped at creation, never the active one.
      let stamp = stampOf(r);
      if (stamp && st.schemaHash && st.schemaHash !== stamp.schemaHash)
        throw schemaError(
          'schema_hash_mismatch',
          'The form changed. Reload it and try again.',
          { reload: true },
        );
      if (content) {
        try {
          stamp ??= await this.structured.stamp(tx, SCHEMA_TYPE, now, {
            version: st.schemaVersion,
            hash: st.schemaHash,
          });
        } catch (e) {
          throw e instanceof PolicyUnavailable ? unavailable() : e;
        }
        await this.structured.validate(
          tx,
          SCHEMA_TYPE,
          stamp,
          content,
          'draft',
        );
      }
      const version = r.version + 1;
      await tx
        .update(problem)
        .set({
          ...input,
          ...(content && { content, ...stamp }),
          ...(st.noSourceNote !== undefined && {
            noSourceNote: st.noSourceNote || null,
          }),
          version,
          updatedAt: now,
        })
        .where(eq(problem.id, id));
      if (content) await this.syncSources(tx, id, content.sources);
      // An edit in review writes a new version; reviewers see which parts changed since (never reopened here: that is T03).
      if (r.state === 'in_review' && content)
        await this.checks.hooks.markChanged(
          tx,
          id,
          version,
          changedPaths((r.content ?? {}) as Record<string, unknown>, content),
        );
      await this.event(tx, id, 'draft_edited', accountId, r.state, r.state, {
        fields: [
          ...Object.keys(input),
          ...(content ? ['content'] : []),
          ...(st.noSourceNote !== undefined ? ['noSourceNote'] : []),
        ],
      });
      return {
        id,
        state: r.state,
        version,
        updatedAt: now.toISOString(),
        ...pin(stamp),
      };
    });
  }

  /**
   * T19. problem_event is insert-only and T00 always wrote an event, so the row cannot be hard-deleted.
   * The draft is scrubbed (all content nulled), stamped deleted_at and made invisible; a retention job removes the row later.
   */
  async remove(accountId: string, id: string): Promise<void> {
    const now = this.clock.now();
    await withTransaction(this.db, async (tx) => {
      const r = await this.lock(tx, id, accountId);
      if (r.state !== 'draft')
        throw new ApiException(
          409,
          'invalid_transition',
          'Only a draft can be discarded.',
        );
      await this.scrubPrep(tx, id);
      await tx
        .update(problem)
        .set({
          title: null,
          condition: null,
          affected: null,
          coarseArea: null,
          desiredOutcome: null,
          observed: null,
          uncertain: null,
          content: null,
          intakeEvidence: null,
          noEvidenceNote: null,
          noSourceNote: null,
          jurisdictionId: null,
          deletedAt: now,
          purgedAt: now,
          version: r.version + 1,
          updatedAt: now,
        })
        .where(eq(problem.id, id));
      await this.event(tx, id, 'draft_deleted', accountId, 'draft', null, {
        transitionId: 'T19',
      });
      await this.audit.record(tx, {
        actorId: accountId,
        action: 'problem.draft_deleted',
        subjectType: 'problem',
        subjectId: id,
      });
    });
  }

  /** Rows that copy draft content (sources, criteria, stage plan) go with the draft. A draft plan has no events or options. */
  private async scrubPrep(tx: Tx, id: string) {
    await tx.delete(sourceRef).where(eq(sourceRef.problemId, id));
    await tx
      .delete(acceptanceCriterion)
      .where(eq(acceptanceCriterion.problemId, id));
    const old = (
      await tx
        .select({ id: stage.id })
        .from(stage)
        .where(eq(stage.problemId, id))
    ).map((x) => x.id);
    if (!old.length) return;
    await tx
      .delete(acceptanceCriterion)
      .where(inArray(acceptanceCriterion.stageId, old));
    await tx.delete(stageEdge).where(inArray(stageEdge.stageId, old));
    await tx.delete(stage).where(inArray(stage.id, old));
  }

  /** source_ref follows the content. A source that stays keeps its DP-SOURCE-TRUST result. */
  private async syncSources(tx: Tx, id: string, sources: unknown) {
    const list = arr(sources);
    const old = await tx
      .select()
      .from(sourceRef)
      .where(eq(sourceRef.problemId, id));
    await tx.delete(sourceRef).where(eq(sourceRef.problemId, id));
    const seen = new Set<string>();
    // Only complete items become rows; a half-filled source stays in the content until the form makes it whole (T01 checks).
    const rows = list
      .filter(
        (s) =>
          typeof s.uri === 'string' &&
          s.uri.startsWith('https://') &&
          SOURCE_CATEGORIES.includes(String(s.category)) &&
          typeof s.establishes === 'string' &&
          s.establishes.trim() !== '' &&
          !seen.has(s.uri) &&
          seen.add(s.uri),
      )
      .map((s, ordinal) => ({
        id: this.ids.next(),
        problemId: id,
        uri: String(s.uri),
        category: String(s.category),
        establishes: String(s.establishes),
        authenticityNote:
          typeof s.authenticity_note === 'string' ? s.authenticity_note : null,
        trustResult:
          old.find((o) => o.uri === s.uri && o.category === s.category)
            ?.trustResult ?? null,
        ordinal,
      }));
    if (rows.length) await tx.insert(sourceRef).values(rows);
  }

  private async mineRow(db: Tx | Db, accountId: string, id: string) {
    const [r] = await db.select().from(problem).where(eq(problem.id, id));
    if (!r || r.initiatorId !== accountId || r.deletedAt) throw notFound();
    return r;
  }

  /** The plan as can_policy stage nodes: a template, or the nodes you sent with `edges` folded into depends_on. */
  private nodesOf(
    content: Record<string, unknown>,
    b: StagePlanInput,
  ): WireStageNode[] {
    if (b.template && b.stages?.length)
      throw new ApiException(
        400,
        'validation_failed',
        'Send a template or stages, not both.',
        {
          template: 'Send a template or stages, not both.',
        },
      );
    const finals = planFromWire(
      [],
      arr(content.final_acceptance_criteria) as unknown as WireFinalCriterion[],
    ).finalCriteria;
    const wire = (stages: StageDraft[]) =>
      planToWire({ planVersion: 1, stages, finalCriteria: [] }).stage_plan;
    if (b.template === 'classic-5')
      return wire(CLASSIC_5.stages as StageDraft[]);
    if (b.template === 'one-stage')
      return wire(ONE_STAGE(finals).stages as StageDraft[]);
    const nodes = structuredClone(arr(b.stages)) as unknown as WireStageNode[];
    for (const e of b.edges ?? []) {
      const to = nodes.find((n) => n.name === e.to);
      if (to && !(to.depends_on ??= []).includes(e.from))
        to.depends_on.push(e.from);
    }
    return nodes;
  }

  /** Schema and graph errors for a stage plan against this draft, as content pointers. */
  private async planProblems(
    tx: Tx | Db,
    r: typeof problem.$inferSelect,
    nodes: WireStageNode[],
  ) {
    const content = { ...((r.content ?? {}) as Record<string, unknown>) };
    if (nodes.length) content.stage_plan = nodes;
    else delete content.stage_plan;
    const errs: Errors = {};
    for (const [k, m] of Object.entries(
      await violations(this.structured, tx, r, content, 'draft'),
    ))
      if (partOf(k) === 'stages') errs[k] = m;
    const plan = Object.keys(errs).length
      ? { issues: [], errors: {} }
      : checkPlan(content);
    return {
      content,
      errors: { ...errs, ...plan.errors },
      issues: plan.issues,
    };
  }

  /** Dry run for the editor (WF-PREP-3): nothing is saved. */
  async validatePlan(accountId: string, id: string, b: StagePlanInput) {
    const r = await this.mineRow(this.db, accountId, id);
    const nodes = this.nodesOf((r.content ?? {}) as Record<string, unknown>, b);
    const p = await this.planProblems(this.db, r, nodes);
    return {
      ok: Object.keys(p.errors).length === 0,
      issues: p.issues as unknown as Record<string, unknown>[],
      fieldErrors: p.errors,
      stages: nodes as unknown as Record<string, unknown>[],
    };
  }

  /**
   * Saves the optional plan (PUT). The nodes live in the draft content (what reviewers see); the stage rows are a
   * working copy for the stage map and are rebuilt from the content when the problem is published.
   * ponytail: only while draft or needs_revision, because savePlan refuses other states; plan edits in review wait for 12-u03.
   */
  async savePlan(
    accountId: string,
    id: string,
    b: StagePlanInput,
    expectedVersion: number,
  ) {
    const now = this.clock.now();
    const out = await withTransaction(this.db, async (tx) => {
      const r = await this.lock(tx, id, accountId);
      if (!PLAN_STATES.includes(r.state))
        throw new ApiException(
          409,
          'invalid_transition',
          'The plan can only change while the problem is a draft or needs changes.',
        );
      if (r.version !== expectedVersion)
        throw new ApiException(
          409,
          'conflict',
          'The problem changed; reload and retry.',
        );
      const nodes = this.nodesOf(
        (r.content ?? {}) as Record<string, unknown>,
        b,
      );
      const p = await this.planProblems(tx, r, nodes);
      if (Object.keys(p.errors).length)
        throw new ApiException(
          400,
          'validation_failed',
          'The stage plan has problems.',
          p.errors,
        );
      const version = r.version + 1;
      await tx
        .update(problem)
        .set({ content: p.content, version, updatedAt: now })
        .where(eq(problem.id, id));
      await this.event(tx, id, 'draft_edited', accountId, r.state, r.state, {
        fields: ['content'],
      });
      return { version, nodes, content: p.content };
    });
    await this.plans.savePlan(
      id,
      planFromWire(
        out.nodes,
        arr(
          out.content.final_acceptance_criteria,
        ) as unknown as WireFinalCriterion[],
      ) as PlanDraft,
    );
    return {
      id,
      version: out.version,
      template: b.template ?? null,
      stages: out.nodes as unknown as Record<string, unknown>[],
      edges: out.nodes.flatMap((n) =>
        (n.depends_on ?? []).map((d) => ({ from: d, to: n.name })),
      ),
    };
  }

  /** WF-PREP-1: per-part readiness with the reason, and the deterministic flags per field. */
  async preparation(accountId: string, id: string) {
    const r = await this.mineRow(this.db, accountId, id);
    const a = await assess(this.structured, this.db, r);
    const flags = (await this.checks.check(r, this.clock.now())).flags;
    const kept = new Set((r.keptFlags ?? []).map((k) => k.id));
    const part = (k: 'facts' | 'sources' | 'criteria' | 'stages') => ({
      ...a.readiness[k],
      flags: flags
        .filter((f) => partOf(f.field) === k)
        .map((f) => ({ ...f, kept: kept.has(f.id) })),
    });
    return {
      id,
      state: r.state,
      version: r.version,
      ready: a.readiness.ready,
      facts: part('facts'),
      sources: part('sources'),
      criteria: part('criteria'),
      stages: part('stages'),
    };
  }

  async mine(
    accountId: string,
    limit: number,
    cursor?: { at: Date; id: string },
  ) {
    const conds = [
      eq(problem.initiatorId, accountId),
      isNull(problem.deletedAt),
    ];
    if (cursor)
      conds.push(
        or(
          lt(problem.updatedAt, cursor.at),
          and(eq(problem.updatedAt, cursor.at), lt(problem.id, cursor.id)),
        )!,
      );
    return this.db
      .select()
      .from(problem)
      .where(and(...conds))
      .orderBy(desc(problem.updatedAt), desc(problem.id))
      .limit(limit + 1);
  }
}
