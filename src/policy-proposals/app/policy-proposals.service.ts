import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { DB, type Db } from '../../db/db.module.js';
import { events, policyProposal } from '../../db/schema.js';
import { withTransaction, type Tx } from '../../db/tx.js';
import { createEvent } from '../../domain/event.js';
import { classifyStatement } from '../../problems/domain/eligibility/classify.js';
import { runChecks } from '../../problems/app/run-checks.js';
import { AuditPort } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors.js';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
} from '../../platform/pagination.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import type { AuthContext } from '../../platform/security/decorators.js';
import { StructuredContentService } from '../../policy/app/structured-content.service.js';
import { PolicyStore } from '../../policy/app/policy-store.js';
import { StructuredContentValidator } from '../../policy/app/structured-content-validator.js';
import {
  PROTECTED_CORE_TEXT,
  protectedHits,
} from '../domain/protected-core.js';
import {
  EVAL_REPORT_SCHEMA,
  blockReason,
  evalRows,
  replaySummary,
} from '../domain/reports.js';
import { REPLAY_REPORT_SCHEMA } from '../domain/replay-report.schema.js';
import {
  REPORT_STAGES,
  blockedTarget,
  canTransition,
  isStage,
  panelStatus,
  type ReportKind,
  type Stage,
} from '../domain/stages.js';

type Row = typeof policyProposal.$inferSelect;
type Json = Record<string, unknown>;

const UUID = /^[0-9a-f-]{36}$/i;
const nf = () => new ApiException(404, 'not_found', 'Not found.');
const DEFAULT_CAP = { count: 2, days: 7 };
const SCHEMAS = {
  eval: ['eval-report', EVAL_REPORT_SCHEMA],
  replay: ['replay-report', REPLAY_REPORT_SCHEMA],
} as const;

const dated = (d: Date) => d.toISOString();
const summary = (r: Row) => ({
  id: r.id,
  stage: r.stage,
  schemaVersion: r.schemaVersion,
  prUrl: r.prUrl,
  changeSummary: String(r.body.change_summary ?? ''),
  createdAt: dated(r.createdAt),
  updatedAt: dated(r.updatedAt),
});

/** Latest reports decide whether the proposal is blocked: eval first, then replay. */
function blocked(r: Row): string | null {
  return (
    (r.evalReport && blockReason('eval', r.evalReport)) ||
    (r.replayReport && blockReason('replay', r.replayReport)) ||
    null
  );
}

@Injectable()
export class PolicyProposalsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(AuditPort) private readonly audit: AuditPort,
    @Inject(PolicyStore) private readonly store: PolicyStore,
    @Inject(StructuredContentService)
    private readonly structured: StructuredContentService,
    @Inject(StructuredContentValidator)
    private readonly validator: StructuredContentValidator,
  ) {}

  // ---- reads ----

  async get(id: string) {
    if (!UUID.test(id)) throw nf();
    const [r] = await this.db
      .select()
      .from(policyProposal)
      .where(eq(policyProposal.id, id));
    if (!r) throw nf();
    return this.view(this.db, r);
  }

  async list(q: { stage?: string; cursor?: string; limit?: string }) {
    const limit = clampLimit(q.limit);
    const c = q.cursor ? decodeCursor(q.cursor) : null;
    const at = c ? new Date(String(c.t)) : null;
    if (c && (Number.isNaN(at!.getTime()) || !UUID.test(String(c.id))))
      throw new ApiException(400, 'validation_failed', 'Invalid cursor', {
        cursor: 'Invalid cursor',
      });
    const rows = await this.db
      .select()
      .from(policyProposal)
      .where(
        and(
          q.stage ? eq(policyProposal.stage, q.stage) : undefined,
          c
            ? or(
                lt(policyProposal.createdAt, at!),
                and(
                  eq(policyProposal.createdAt, at!),
                  lt(policyProposal.id, String(c.id)),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(policyProposal.createdAt), desc(policyProposal.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(summary),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  private async view(db: Db | Tx, r: Row) {
    const log = await db
      .select({ payload: events.payload, at: events.occurredAt })
      .from(events)
      .where(
        and(
          eq(events.objectId, r.id),
          eq(events.eventType, 'policy_proposal.stage_changed'),
        ),
      )
      .orderBy(asc(events.occurredAt));
    const rollout = log
      .filter((e) =>
        ['shadow', 'canary', 'full'].includes(String(e.payload.to)),
      )
      .map((e) => ({ stage: String(e.payload.to), at: dated(e.at) }));
    return {
      ...summary(r),
      body: r.body,
      protectedCoreFlag: r.protectedCoreFlag,
      eval: r.evalReport ? evalRows(r.evalReport) : null,
      replay: r.replayReport ? replaySummary(r.replayReport) : null,
      blockedReason: blocked(r),
      // ponytail: transitional is constant until a ratifying panel exists (OQ-founder-stewardship-sunset).
      ratification: {
        panelStatus: panelStatus(r.stage as Stage),
        transitional: true,
      },
      rollout,
    };
  }

  // ---- writes ----

  /**
   * Gates: schema (10-u29), protected core, then the deterministic content checks
   * (privacy, naming, secrets, crisis phrases). The plan-09 moderation port is not present yet.
   */
  async submit(
    auth: AuthContext,
    b: { content: Json; schemaVersion?: string; schemaHash?: string },
  ) {
    const now = this.clock.now();
    const pack = this.store.active('default');
    const id = this.ids.next();
    return withTransaction(this.db, async (tx) => {
      const stamp = await this.structured.stamp(tx, 'policy_proposal', now, {
        version: b.schemaVersion,
        hash: b.schemaHash,
      });
      await this.structured.validate(tx, 'policy_proposal', stamp, b.content);

      const touched = (b.content.rule_ids_and_dps_touched as string[]) ?? [];
      const hits = protectedHits(touched, pack.protectedCore);
      const claims = (b.content.protected_core_check as Json | undefined)
        ?.touches_protected_core;
      if (hits.length || claims === true)
        throw new ApiException(
          422,
          'protected_core',
          PROTECTED_CORE_TEXT,
          hits.length
            ? {
                '/rule_ids_and_dps_touched': `Protected-core rules: ${hits.join(', ')}.`,
              }
            : {
                '/protected_core_check/touches_protected_core': 'Not allowed.',
              },
        );

      this.contentGate(b.content);

      // One proposal at a time per account through the cap check.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${'policy_proposal:' + auth.accountId}))`,
      );
      const caps = (pack.limits.caps as Json | undefined)
        ?.policy_proposals_per_account_per_period as
        { count?: number; days?: number } | undefined;
      const cap = { ...DEFAULT_CAP, ...caps };
      const since = new Date(now.getTime() - cap.days * 86_400_000);
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(policyProposal)
        .where(
          and(
            eq(policyProposal.accountId, auth.accountId),
            sql`${policyProposal.createdAt} >= ${since}`,
          ),
        );
      if (n >= cap.count)
        throw new ApiException(
          429,
          'rate_limited',
          `You can send ${cap.count} policy proposals every ${cap.days} days. Try again later.`,
        );

      const [row] = await tx
        .insert(policyProposal)
        .values({
          id,
          accountId: auth.accountId,
          schemaVersion: stamp.schemaVersion,
          schemaHash: stamp.schemaHash,
          body: b.content,
          stage: 'submitted',
          protectedCoreFlag: false,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await this.record(tx, auth.accountId, id, 'submitted', now, {
        to: 'submitted',
      });
      return this.view(tx, row);
    });
  }

  async attachReports(
    id: string,
    auth: AuthContext,
    b: { eval?: Json; replay?: Json; prUrl?: string },
  ) {
    if (!UUID.test(id)) throw nf();
    const kinds = (['eval', 'replay'] as const).filter((k) => b[k]);
    if (!kinds.length)
      throw new ApiException(400, 'validation_failed', 'Send a report.', {
        '/': 'Send an eval or a replay report.',
      });
    const errs: Record<string, string> = {};
    for (const k of kinds) {
      const [key, schema] = SCHEMAS[k];
      for (const v of this.validator.validate(
        key,
        schema as unknown as Json,
        b[k],
      ))
        errs[`/${k}${v.pointer}`] = v.message;
    }
    if (Object.keys(errs).length)
      throw new ApiException(
        400,
        'validation_failed',
        'The report is not valid.',
        errs,
      );

    const now = this.clock.now();
    return withTransaction(this.db, async (tx) => {
      let r = await this.lock(tx, id);
      for (const k of kinds) {
        const stage = r.stage as Stage;
        if (!REPORT_STAGES[k].includes(stage))
          throw new ApiException(
            409,
            'invalid_transition',
            'This proposal cannot take that report at its stage.',
          );
        const report = b[k]!;
        const reason = blockReason(k as ReportKind, report);
        [r] = await tx
          .update(policyProposal)
          .set({
            [k === 'eval' ? 'evalReport' : 'replayReport']: report,
            ...(b.prUrl && { prUrl: b.prUrl }),
            updatedAt: now,
          })
          .where(eq(policyProposal.id, id))
          .returning();
        await this.record(tx, auth.accountId, id, 'report_attached', now, {
          kind: k,
          blocked: reason !== null,
          ...(reason && { reason }),
        });
        const to = reason ? blockedTarget(k, stage) : null;
        if (to) r = await this.move(tx, r, to, auth.accountId, now, reason);
      }
      if (b.prUrl && r.prUrl !== b.prUrl)
        [r] = await tx
          .update(policyProposal)
          .set({ prUrl: b.prUrl, updatedAt: now })
          .where(eq(policyProposal.id, id))
          .returning();
      return this.view(tx, r);
    });
  }

  async moveStage(
    id: string,
    auth: AuthContext,
    b: { to: string; reason?: string },
  ) {
    if (!UUID.test(id)) throw nf();
    const now = this.clock.now();
    return withTransaction(this.db, async (tx) => {
      const r = await this.lock(tx, id);
      if (!isStage(b.to) || !canTransition(r.stage as Stage, b.to))
        throw new ApiException(
          409,
          'invalid_transition',
          'That stage change is not allowed.',
        );
      // A forward move to ratification needs both reports in and neither blocking.
      if (
        b.to === 'ratification' &&
        (!r.evalReport || !r.replayReport || blocked(r))
      )
        throw new ApiException(
          409,
          'invalid_transition',
          'Ratification needs passing eval and replay reports.',
        );
      return this.view(
        tx,
        await this.move(tx, r, b.to, auth.accountId, now, b.reason ?? null),
      );
    });
  }

  // ---- helpers ----

  private async lock(tx: Tx, id: string): Promise<Row> {
    const [r] = await tx
      .select()
      .from(policyProposal)
      .where(eq(policyProposal.id, id))
      .for('update');
    if (!r) throw nf();
    return r;
  }

  /** One stage change = one row update, one `events` row and one `audit_event`. */
  private async move(
    tx: Tx,
    r: Row,
    to: Stage,
    actorId: string,
    now: Date,
    reason: string | null,
  ): Promise<Row> {
    if (!canTransition(r.stage as Stage, to))
      throw new ApiException(
        409,
        'invalid_transition',
        'That stage change is not allowed.',
      );
    const [u] = await tx
      .update(policyProposal)
      .set({ stage: to, updatedAt: now })
      .where(eq(policyProposal.id, r.id))
      .returning();
    await this.record(tx, actorId, r.id, 'stage_changed', now, {
      from: r.stage,
      to,
      ...(reason && { reason }),
    });
    return u;
  }

  /** Never puts the proposal body in the log: stages, kinds, verdicts and reasons only. */
  private async record(
    tx: Tx,
    actorId: string,
    id: string,
    type: string,
    now: Date,
    payload: Json,
  ) {
    await tx.insert(events).values({
      ...createEvent({
        objectId: id,
        objectType: 'policy_proposal',
        eventType: `policy_proposal.${type}`,
        originNodeId: config.nodeId,
        actor: actorId,
        occurredAt: now,
        payload,
      }),
      id: this.ids.next(),
    });
    await this.audit.record(tx, {
      actorId,
      action: `policy_proposal.${type}`,
      subjectType: 'policy_proposal',
      subjectId: id,
      detail: payload,
      transitional: true,
    });
  }

  private contentGate(content: Json) {
    const errs: Record<string, string> = {};
    for (const f of runChecks({ fields: {}, content }).flags)
      errs[f.field.replace(/^\/content/, '') || '/'] =
        'Remove personal details, names or secrets from this text.';
    const text = JSON.stringify(content);
    const c = classifyStatement(text);
    if (!c.ok && c.ineligibilityCode === 'emergency') errs['/'] = c.hint;
    if (Object.keys(errs).length)
      throw new ApiException(
        400,
        'validation_failed',
        'Some answers need attention.',
        errs,
      );
  }
}
