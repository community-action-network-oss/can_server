import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import { problem, problemEvent } from '../../db/schema.js';
import { withTransaction, type Tx } from '../../db/tx.js';
import { evaluateTransition } from '../../domain/lifecycle/guard.js';
import type { ActorKind, ConditionName } from '../../domain/lifecycle/table.js';
import { config } from '../../config.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';
import { AuditPort } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors.js';
import { buildProblemEvent } from '../../platform/events.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import {
  DECISION_NOTIFIER,
  REVIEW_FACTS,
  TransitionEffects,
  type DecisionNotifier,
  type ReviewFacts,
} from './transition-ports.js';
import type { State } from '../../domain/lifecycle/vocabulary.js';

export interface ApplyInput {
  problemId: string;
  to: State;
  actor: { kind: ActorKind; id: string | null };
  fields?: Record<string, unknown>;
  reason?: string | null;
  /** direct (default): apply or decide. propose: initiator or system proposal. decline: a run declines the pending proposal. */
  action?: 'direct' | 'propose' | 'decline';
  runId?: string;
  expectedVersion?: number;
  /** Disambiguates T14 vs T20 on stuck to active. */
  transitionId?: string;
  /** Facts only the caller can know (T13, T15, T18). Review conditions always come from the ReviewFacts port. */
  conditions?: Partial<Record<ConditionName, boolean>>;
  /** Policy pack version, carried into the event and audit detail when a run decides. */
  policyVersion?: string;
  /** True when the run's pack was ratified only by transitional stewardship (INTERIM-1). */
  transitional?: boolean;
}
export interface ApplyResult {
  state: string;
  version: number;
  eventType: string;
}

const DAY = 86_400_000;
const REOPEN_NOT_YET = new Set(['T20', 'T21']);
const EVENT_BY_TO: Record<string, string> = {
  solved: 'solved',
  closed: 'closed',
  redirected: 'redirected',
};

const fail = (
  status: number,
  code: string,
  msg: string,
  f?: Record<string, string>,
) => new ApiException(status, code, msg, f);

@Injectable()
export class TransitionEngine {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(AuditPort) private readonly audit: AuditPort,
    @Inject(REVIEW_FACTS) private readonly review: ReviewFacts,
    @Inject(DECISION_NOTIFIER) private readonly notifier: DecisionNotifier,
    @Inject(TransitionEffects) readonly effects: TransitionEffects,
  ) {}

  async apply(i: ApplyInput): Promise<ApplyResult> {
    const result = await withTransaction(this.db, (tx) => this.inTx(tx, i));
    await this.notifier.notify({
      problemId: i.problemId,
      kind:
        i.action === 'propose'
          ? 'proposed'
          : i.action === 'decline'
            ? 'declined'
            : 'applied',
      to: i.to,
    });
    return result;
  }

  private async inTx(tx: Tx, i: ApplyInput): Promise<ApplyResult> {
    const [row] = await tx
      .select()
      .from(problem)
      .where(eq(problem.id, i.problemId))
      .for('update');
    if (!row) throw fail(404, 'not_found', 'Problem not found.');
    if (i.expectedVersion !== undefined && i.expectedVersion !== row.version)
      throw fail(409, 'conflict', 'The problem changed; reload and retry.');
    if (
      i.actor.kind === 'initiator' &&
      (!row.initiatorId || row.initiatorId !== i.actor.id)
    )
      throw fail(403, 'not_permitted', 'Only the initiator can do that.');

    const now = this.clock.now();
    const action = i.action ?? 'direct';
    const fields = i.fields ?? {};
    const from = row.state as State;
    const pending = row.pendingTransition as {
      to?: string;
      transitionId?: string;
    } | null;
    const ev = (
      type: string,
      extra: Record<string, unknown>,
      toState?: string,
    ) =>
      tx
        .insert(problemEvent)
        .values(this.event(row.id, type, i, from, toState ?? null, extra, now));
    const pendingCleared = {
      pendingTransition: null,
      version: row.version + 1,
      updatedAt: now,
    };

    if (action === 'decline') {
      if (i.actor.kind !== 'run' || !i.runId)
        throw fail(
          403,
          'not_permitted',
          'Only a recorded run can decline a proposal.',
        );
      if (!pending)
        throw fail(409, 'invalid_transition', 'Nothing is pending.');
      await tx
        .update(problem)
        .set(pendingCleared)
        .where(eq(problem.id, row.id));
      await ev('transition_declined', {
        ruleIds: fields.ruleIds ?? [],
        explanation: fields.explanation ?? null,
        transitionId: pending.transitionId,
      });
      await this.auditRun(
        tx,
        i,
        row.id,
        'problem.transition_declined',
        pending.transitionId,
      );
      return {
        state: from,
        version: row.version + 1,
        eventType: 'transition_declined',
      };
    }

    if (from === ('deleted' as string))
      throw fail(409, 'invalid_transition', 'Not a valid transition.');
    const facts = from === 'in_review' ? await this.review.get(tx, row.id) : {};
    const res = evaluateTransition({
      from,
      to: i.to,
      actor: i.actor.kind,
      fields,
      transitionId: i.transitionId,
      context: {
        ...i.conditions,
        ...facts,
        runId: i.runId,
        resumeState: (row.resumeState as State | null) ?? undefined,
      },
    });
    if (!res.ok) {
      if (res.code === 'missing_fields')
        throw fail(
          400,
          'validation_failed',
          'Required fields are missing.',
          Object.fromEntries((res.missing ?? []).map((k) => [k, 'required'])),
        );
      if (res.code === 'not_permitted')
        throw fail(403, 'not_permitted', 'You cannot do that.');
      throw fail(
        409,
        'invalid_transition',
        res.code === 'condition_failed'
          ? `Conditions for ${res.transitionId} are not met.`
          : 'Not a valid transition.',
      );
    }
    const t = res.transition;
    // ponytail: T20 and T21 (system-only reopen) arrive with 09-u63; T00 and T19 have no row to change here (draft store, 03-u16).
    if (REOPEN_NOT_YET.has(t.id) || t.id === 'T00' || t.id === 'T19')
      throw fail(403, 'not_permitted', 'Not available here.');
    if (
      t.id === 'T16' &&
      fields.duplicateOf &&
      fields.reasonCode !== 'duplicate'
    )
      throw fail(
        400,
        'validation_failed',
        'duplicateOf needs the duplicate reason.',
        { duplicateOf: 'invalid' },
      );

    if (action === 'propose') {
      if (res.mode !== 'propose')
        throw fail(403, 'not_permitted', 'This transition is not a proposal.');
      if (pending)
        throw fail(409, 'conflict', 'A proposal is already pending.');
      await tx
        .update(problem)
        .set({
          pendingTransition: {
            to: i.to,
            transitionId: t.id,
            proposedBy: [i.actor.kind],
            fields,
            proposedAt: now.toISOString(),
          },
          version: row.version + 1,
          updatedAt: now,
        })
        .where(eq(problem.id, row.id));
      await ev('transition_proposed', { transitionId: t.id });
      return {
        state: from,
        version: row.version + 1,
        eventType: 'transition_proposed',
      };
    }
    if (res.mode === 'propose')
      throw fail(
        403,
        'not_permitted',
        'This transition must be proposed and decided by a run.',
      );

    const toState = t.to === 'same' ? from : i.to;
    const set: Partial<typeof problem.$inferInsert> = {
      ...pendingCleared,
      state: toState,
    };
    if (t.id === 'T01') set.reviewRequestedAt = now;
    if (t.id === 'T04') set.publishedAt = now;
    if (['T05', 'T06', 'T07'].includes(t.id))
      set.purgeAfter = new Date(now.getTime() + 30 * DAY);
    if (['T08', 'T09', 'T11'].includes(t.id)) set.resumeState = from;
    if (t.id === 'T10' || t.id === 'T12') set.resumeState = null;
    if (t.id === 'T11') {
      set.pauseReason = String(fields.reasonCode);
      set.resumeCondition = String(fields.resumeCondition);
    }
    if (t.id === 'T12') {
      set.pauseReason = null;
      set.resumeCondition = null;
    }
    if (t.id === 'T16' && typeof fields.duplicateOf === 'string')
      set.duplicateOf = fields.duplicateOf;
    if (t.id === 'T18') {
      set.tombstonedAt = now;
      set.withdrawnPublished = row.publishedAt !== null;
    }
    if (t.id === 'T22') set.planVersion = row.planVersion + 1;
    await tx.update(problem).set(set).where(eq(problem.id, row.id));

    await this.effects.runFor(tx, {
      problemId: row.id,
      transitionId: t.id,
      from,
      to: toState as State,
      actor: i.actor,
      fields,
      runId: i.runId,
      now,
    });
    if (pending)
      await ev('transition_decided', { transitionId: pending.transitionId });
    const type =
      t.id === 'T22'
        ? 'plan_changed'
        : t.id === 'T04'
          ? 'published'
          : (EVENT_BY_TO[toState] ?? 'state_changed');
    await ev(
      type,
      {
        transitionId: t.id,
        ...(i.runId && { runId: i.runId }),
        ...(i.policyVersion && { policyVersion: i.policyVersion }),
      },
      toState,
    );
    if (i.actor.kind === 'run' || i.actor.kind === 'lane')
      await this.auditRun(tx, i, row.id, 'problem.transition', t.id);
    return { state: toState, version: row.version + 1, eventType: type };
  }

  private event(
    problemId: string,
    type: string,
    i: ApplyInput,
    from: string,
    to: string | null,
    payload: Record<string, unknown>,
    now: Date,
  ) {
    const e = buildProblemEvent(
      {
        problemId,
        type,
        actorId: i.actor.id,
        from,
        to,
        reason: i.reason ?? null,
        payload,
      },
      { clock: { now: () => now }, ids: this.ids, originNodeId: config.nodeId },
    );
    return {
      id: e.id,
      problemId,
      type,
      actorId: i.actor.id,
      fromState: from,
      toState: to,
      reason: i.reason ?? null,
      payload: e.payload,
      prevHash: null,
      originNodeId: e.originNodeId,
      protocolVersion: PROTOCOL_VERSION,
      occurredAt: e.occurredAt,
    };
  }

  private auditRun(
    tx: Tx,
    i: ApplyInput,
    problemId: string,
    action: string,
    transitionId?: string,
  ) {
    return this.audit.record(tx, {
      actorId: i.actor.id,
      action,
      subjectType: 'problem',
      subjectId: problemId,
      transitional: i.transitional ?? false,
      detail: { transitionId, runId: i.runId, policyVersion: i.policyVersion },
    });
  }
}
