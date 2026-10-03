import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { config } from '../../config.js';
import { DB, type Db } from '../../db/db.module.js';
import {
  acceptanceCriterion,
  problem,
  problemEvent,
  stage,
  stageChoice,
  stageEdge,
  stageEvent,
  stageEvidence,
} from '../../db/schema.js';
import { withTransaction, type Tx } from '../../db/tx.js';
import { evaluateTransition } from '../../domain/lifecycle/guard.js';
import type { State } from '../../domain/lifecycle/vocabulary.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';
import { ApiException } from '../../platform/errors.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import { TransitionEngine } from '../../problems/app/transition-engine.js';
import { TransitionEffects } from '../../problems/app/transition-ports.js';
import { finalCheckDue, readyStages, settled } from '../domain/gating.js';
import {
  evaluateStageTransition,
  STAGE_TRANSITIONS,
  type StageActor,
} from '../domain/transitions.js';
import type { StagePlan, StageState, StageStates } from '../domain/types.js';
import { visibleToViewer } from '../infra/stage-plan.repo.js';
import {
  BLOCKER_RECORD_PORT,
  TASK_PORT,
  type BlockerRecordPort,
  type TaskPort,
} from './ports.js';

export interface StageApplyInput {
  stageId: string;
  /** `prior` is ST08: back to the state the stage had before the block. */
  to: StageState | 'prior';
  /** `steward` ids must be the poster; `run` needs `runId`. */
  actor: { kind: StageActor; id: string | null };
  /** camelCase keys named by the transition table (`required`). */
  fields?: Record<string, unknown>;
  reason?: string;
  runId?: string;
}
export interface StageApplyResult {
  stageId: string;
  state: StageState;
}

export interface AllowedStageTransition {
  to: string;
  requires: string[];
  mode: 'direct';
}

/** What the viewer may do with a stage now, straight from the domain table. Only the steward has actions here. */
export function allowedStageTransitions(
  state: StageState,
  resumeState: string | null,
  steward: boolean,
): AllowedStageTransition[] {
  if (!steward) return [];
  return STAGE_TRANSITIONS.filter(
    (t) => t.from.includes(state) && t.actors.includes('steward'),
  ).flatMap((t) => {
    const to = t.to === 'prior' ? resumeState : t.to;
    return to
      ? [{ to, requires: [...t.required], mode: 'direct' as const }]
      : [];
  });
}

const UUID = /^[0-9a-f-]{36}$/i;
const fail = (
  status: number,
  code: string,
  msg: string,
  f?: Record<string, string>,
) => new ApiException(status, code, msg, f);
const notFound = () => fail(404, 'not_found', 'Not found.');

type StageRow = typeof stage.$inferSelect;
type ProblemRow = typeof problem.$inferSelect;

/**
 * The stage state machine on rows (12-u06). Every stage change, its gating result and its events commit together.
 * Lock order: the problem row, then every stage of the problem in id order, so concurrent resolutions cannot deadlock.
 * Effects that reach back into the problem engine use the transaction they were given (12-u04 trap: savePlan hangs there).
 */
@Injectable()
export class StageEngine {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(TASK_PORT) private readonly tasks: TaskPort,
    @Inject(BLOCKER_RECORD_PORT) private readonly blockers: BlockerRecordPort,
    @Inject(TransitionEngine) private readonly problems: TransitionEngine,
    @Inject(TransitionEffects) effects: TransitionEffects,
  ) {
    // ST09: closure, redirect and withdrawal skip every unresolved stage in the same transaction.
    effects.register({
      on: ['T16', 'T17', 'T18'],
      run: (tx, c) =>
        this.skipUnresolved(
          tx,
          c.problemId,
          [c.to, c.fields.reasonCode].filter(Boolean).join(': '),
          c.now,
        ),
    });
  }

  apply(i: StageApplyInput): Promise<StageApplyResult> {
    return withTransaction(this.db, (tx) => this.applyIn(tx, i));
  }

  /**
   * ST08 for a stuck problem: T14 goes first through the problem engine (its own transaction, so before ours).
   * A steward can only propose T14 (a run decides it), so the stage stays blocked and the call says why.
   */
  async unblock(i: Omit<StageApplyInput, 'to'>): Promise<StageApplyResult> {
    const [r] = await this.db
      .select({ p: problem })
      .from(stage)
      .innerJoin(problem, eq(problem.id, stage.problemId))
      .where(eq(stage.id, this.uid(i.stageId)));
    if (!r) throw notFound();
    if (r.p.state === 'stuck') {
      const fields = {
        blockerClearedNote: i.fields?.clearedNote,
        evidenceIds: i.fields?.evidence,
      };
      if (i.actor.kind === 'run')
        await this.problems.apply({
          problemId: r.p.id,
          to: 'active',
          actor: { kind: 'run', id: i.actor.id },
          transitionId: 'T14',
          runId: i.runId,
          fields,
        });
      else {
        if (i.actor.id !== r.p.initiatorId)
          throw fail(403, 'not_permitted', 'You cannot do that.');
        await this.problems.apply({
          problemId: r.p.id,
          to: 'active',
          actor: { kind: 'initiator', id: i.actor.id },
          transitionId: 'T14',
          action: 'propose',
          fields,
        });
        throw fail(
          409,
          'problem_not_active',
          'Your note was sent to be checked. The stage resumes once the problem is active again.',
        );
      }
    }
    return this.apply({ ...i, to: 'prior' });
  }

  async applyIn(tx: Tx, i: StageApplyInput): Promise<StageApplyResult> {
    const { p, rows, plan, states } = await this.lockPlan(tx, i.stageId);
    const s = rows.find((r) => r.id === i.stageId)!;
    if (i.actor.kind === 'steward') {
      if (!visibleToViewer(p, i.actor.id)) throw notFound();
      if (!i.actor.id || i.actor.id !== p.initiatorId)
        throw fail(403, 'not_permitted', 'Only the steward can do that.');
    }
    const now = this.clock.now();
    const from = s.state as StageState;
    const to = i.to === 'prior' ? (s.resumeState as StageState | null) : i.to;
    if (!to) throw fail(409, 'invalid_transition', 'Not a valid transition.');
    if (from === 'planned' && to === 'active')
      throw fail(409, 'not_ready', 'This stage has not started.');
    // 01b 4b.4: while the problem is paused or stuck no stage starts or resolves.
    if (
      p.state !== 'active' &&
      ((from === 'ready' && to === 'active') ||
        (from === 'active' && to === 'resolving') ||
        (from === 'resolving' && to === 'resolved'))
    )
      throw fail(409, 'problem_not_active', 'The problem is not active now.');

    const fields = i.fields ?? {};
    const ctx = await this.context(tx, p, s, plan, states, i, from);
    const res = evaluateStageTransition({
      from,
      to,
      actor: i.actor.kind,
      fields,
      context: ctx.guard,
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
      if (res.code === 'condition_failed') {
        if (res.transitionId === 'ST04')
          throw fail(
            400,
            'validation_failed',
            'The stage is not ready to submit.',
            ctx.unmet,
          );
        throw fail(
          409,
          p.state === 'active' ? 'not_ready' : 'problem_not_active',
          'The conditions for this step are not met.',
        );
      }
      throw fail(409, 'invalid_transition', 'Not a valid transition.');
    }
    const t = res.transition;
    // ponytail: reopen (ST10) and restore (ST11) are plan changes; 12-u09 owns them.
    if (t.id === 'ST10' || t.id === 'ST11')
      throw fail(409, 'invalid_transition', 'Not available here.');

    const before = { ...states };
    const payload: Record<string, unknown> = {
      transitionId: t.id,
      planVersion: s.planVersion,
      ...(i.runId && { runId: i.runId }),
    };
    const set: Partial<typeof stage.$inferInsert> = { state: to };
    if (t.id === 'ST07') {
      // A block during resolving resumes in active: the judgement is redone after the block clears.
      set.resumeState = from === 'resolving' ? 'active' : from;
      Object.assign(
        payload,
        await this.blockers.record(tx, {
          stageId: s.id,
          record: pick(fields, [
            'blocker',
            'source',
            'sourceVersion',
            'blockedActions',
            'recheckCondition',
            'nextRoute',
            'attempts',
          ]),
        }),
      );
    }
    if (t.id === 'ST08') {
      set.resumeState = null;
      payload.cleared = pick(fields, ['clearedNote', 'evidence']);
    }
    if (t.id === 'ST05' || t.id === 'ST06')
      Object.assign(
        payload,
        pick(fields, ['ruleIds', 'criterionResults', 'policyVersion']),
      );
    await tx.update(stage).set(set).where(eq(stage.id, s.id));
    states[s.id] = to;
    await this.event(tx, s, {
      from,
      to,
      actorId: i.actor.kind === 'steward' ? i.actor.id : null,
      reason:
        i.reason ?? (typeof fields.reason === 'string' ? fields.reason : null),
      payload,
      now,
    });
    if (t.id === 'ST04') {
      // Freeze what the judgement will read, then leave the job for DP-STAGE-RESOLUTION (12-u07: stages in `resolving`).
      await tx
        .update(stageEvidence)
        .set({ frozenAt: now })
        .where(
          and(eq(stageEvidence.stageId, s.id), isNull(stageEvidence.frozenAt)),
        );
      await this.event(tx, s, {
        type: 'resolution_queued',
        from: to,
        to,
        actorId: null,
        payload: { decisionPoint: 'DP-STAGE-RESOLUTION' },
        now,
      });
    }
    await this.gate(tx, p, rows, plan, before, states, now);
    return { stageId: s.id, state: to };
  }

  /** STAGE-GATE-1, exactly once: callers hold the problem lock, so only one transaction sees a stage still `planned`. */
  private async gate(
    tx: Tx,
    p: ProblemRow,
    rows: StageRow[],
    plan: StagePlan,
    before: StageStates,
    states: StageStates,
    now: Date,
  ) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ready = readyStages(plan, states).sort();
    for (const id of ready) {
      const r = byId.get(id)!;
      await tx.update(stage).set({ state: 'ready' }).where(eq(stage.id, id));
      states[id] = 'ready';
      await this.event(tx, r, {
        from: 'planned',
        to: 'ready',
        actorId: null,
        payload: { transitionId: 'ST02', planVersion: r.planVersion },
        now,
      });
    }
    for (const id of ready) {
      const r = byId.get(id)!;
      if (
        p.state !== 'active' ||
        !evaluateStageTransition({
          from: 'ready',
          to: 'active',
          actor: 'system',
          context: { problemState: 'active', autoStart: r.autoStart },
        }).ok
      )
        continue;
      await tx.update(stage).set({ state: 'active' }).where(eq(stage.id, id));
      states[id] = 'active';
      await this.event(tx, r, {
        from: 'ready',
        to: 'active',
        actorId: null,
        payload: { transitionId: 'ST03', planVersion: r.planVersion },
        now,
      });
    }
    if (p.state !== 'active') return;
    // Both signals fire on the change from false to true, so each is queued once.
    if (!finalCheckDue(plan, before) && finalCheckDue(plan, states))
      await this.proposeFinalCheck(tx, p, plan, states, now);
    const stuck = stuckStages(plan, states);
    if (!stuckStages(plan, before).length && stuck.length)
      // The event is the queue entry for DP-BLOCKER and T13; the run decides, never this engine.
      await tx.insert(problemEvent).values({
        id: this.ids.next(),
        problemId: p.id,
        type: 'problem.stuck_candidate',
        actorId: null,
        fromState: p.state,
        toState: null,
        payload: { stageIds: stuck, decisionPoint: 'DP-BLOCKER' },
        prevHash: null,
        originNodeId: config.nodeId,
        protocolVersion: PROTOCOL_VERSION,
        occurredAt: now,
      });
  }

  /**
   * T15 as a system proposal, written like the problem engine's `propose` branch (same pending_transition shape).
   * ponytail: the problem engine opens its own transaction, so it cannot be called from here; swap this for an in-tx
   * entry point on TransitionEngine when 03-u05 grows one.
   */
  private async proposeFinalCheck(
    tx: Tx,
    p: ProblemRow,
    plan: StagePlan,
    states: StageStates,
    now: Date,
  ) {
    if (p.pendingTransition) return;
    const stageIds = plan.stages
      .filter((s) => settled(states[s.id]))
      .map((s) => s.id);
    const met = stageIds.length
      ? await tx
          .select({ metBy: acceptanceCriterion.metBy })
          .from(acceptanceCriterion)
          .where(inArray(acceptanceCriterion.stageId, stageIds))
      : [];
    const evidenceIds = [...new Set(met.flatMap((m) => m.metBy))];
    const finals = await tx
      .select({ id: acceptanceCriterion.id })
      .from(acceptanceCriterion)
      .where(eq(acceptanceCriterion.problemId, p.id))
      .orderBy(asc(acceptanceCriterion.ordinal));
    // ponytail: the model has no link from a stage criterion to a final one, so every resolved stage's evidence is offered
    // for each final criterion and DP-VERIFICATION picks. Add the link when 09-u42 needs it.
    const fields = {
      criteriaEvidence: finals.map((c, n) => ({
        criterionRef: n + 1,
        evidenceIds,
      })),
      outcomeStatement: 'Every required stage is resolved or skipped.',
    };
    const g = evaluateTransition({
      from: 'active',
      to: 'solved',
      actor: 'system',
      transitionId: 'T15',
      fields,
    });
    if (!g.ok || g.mode !== 'propose') return; // fail closed: no proposal, the poster can still propose T15
    await tx
      .update(problem)
      .set({
        pendingTransition: {
          to: 'solved',
          transitionId: 'T15',
          proposedBy: ['system'],
          fields,
          proposedAt: now.toISOString(),
        },
        version: p.version + 1,
        updatedAt: now,
      })
      .where(eq(problem.id, p.id));
    await tx.insert(problemEvent).values({
      id: this.ids.next(),
      problemId: p.id,
      type: 'transition_proposed',
      actorId: null,
      fromState: p.state,
      toState: null,
      payload: { transitionId: 'T15' },
      prevHash: null,
      originNodeId: config.nodeId,
      protocolVersion: PROTOCOL_VERSION,
      occurredAt: now,
    });
  }

  /** ST09 by the system. A stage in `resolving` is skipped too: no run can finish it once the problem has ended. */
  private async skipUnresolved(
    tx: Tx,
    problemId: string,
    reason: string,
    now: Date,
  ) {
    const rows = await tx
      .select()
      .from(stage)
      .where(eq(stage.problemId, problemId))
      .orderBy(asc(stage.id))
      .for('update');
    for (const r of rows) {
      if (settled(r.state as StageState)) continue;
      await tx
        .update(stage)
        .set({ state: 'skipped', resumeState: null })
        .where(eq(stage.id, r.id));
      await this.event(tx, r, {
        from: r.state,
        to: 'skipped',
        actorId: null,
        reason,
        payload: { transitionId: 'ST09', planVersion: r.planVersion },
        now,
      });
    }
  }

  // ---- helpers ----

  private uid(id: string) {
    if (!UUID.test(id)) throw notFound();
    return id;
  }

  private async lockPlan(tx: Tx, stageId: string) {
    const [one] = await tx
      .select({ problemId: stage.problemId })
      .from(stage)
      .where(eq(stage.id, this.uid(stageId)));
    if (!one) throw notFound();
    const [p] = await tx
      .select()
      .from(problem)
      .where(eq(problem.id, one.problemId))
      .for('update');
    const rows = await tx
      .select()
      .from(stage)
      .where(eq(stage.problemId, p.id))
      .orderBy(asc(stage.id))
      .for('update');
    const edges = await tx
      .select()
      .from(stageEdge)
      .where(
        inArray(
          stageEdge.stageId,
          rows.map((r) => r.id),
        ),
      );
    const plan: StagePlan = {
      planVersion: p.planVersion,
      finalCriteria: [],
      stages: rows.map((r) => ({
        id: r.id,
        name: r.label ?? r.name,
        goal: r.goal,
        decisionMethod: r.decisionMethod as never,
        required: r.required,
        needsChoice: r.needsChoice,
        autoStart: r.autoStart,
        dependsOn: edges
          .filter((e) => e.stageId === r.id)
          .map((e) => e.dependsOnId),
        criteria: [],
      })),
    };
    const states = Object.fromEntries(
      rows.map((r) => [r.id, r.state as StageState]),
    ) as StageStates;
    return { p, rows, plan, states };
  }

  /** Facts the guard needs. `unmet` names what ST04 lacks, for fieldErrors. */
  private async context(
    tx: Tx,
    p: ProblemRow,
    s: StageRow,
    plan: StagePlan,
    states: StageStates,
    i: StageApplyInput,
    from: StageState,
  ) {
    const guard: Parameters<typeof evaluateStageTransition>[0]['context'] = {
      problemState: p.state as State,
      predecessorsResolved: plan.stages
        .find((x) => x.id === s.id)!
        .dependsOn.every((d) => settled(states[d])),
      autoStart: s.autoStart,
      runId: i.runId,
      priorState:
        s.resumeState === 'ready' || s.resumeState === 'active'
          ? s.resumeState
          : undefined,
    };
    const unmet: Record<string, string> = {};
    if (from === 'active') {
      // Fail closed: a choice counts only with a passed CHOICE-GATE result.
      const choice = s.needsChoice
        ? await tx
            .select({ g: stageChoice.gateResult })
            .from(stageChoice)
            .where(
              and(
                eq(stageChoice.stageId, s.id),
                isNull(stageChoice.withdrawnAt),
              ),
            )
        : [];
      guard.choiceRecorded =
        !s.needsChoice || choice.some((c) => c.g?.result === 'passed');
      const openTasks = await this.tasks.openRequired(tx, s.id);
      guard.tasksDone = openTasks.length === 0;
      const crit = new Set(
        (
          await tx
            .select({ id: acceptanceCriterion.id })
            .from(acceptanceCriterion)
            .where(eq(acceptanceCriterion.stageId, s.id))
        ).map((c) => c.id),
      );
      const ev = await tx
        .select({ c: stageEvidence.criteriaIds })
        .from(stageEvidence)
        .where(eq(stageEvidence.stageId, s.id));
      guard.evidenceMapped = ev.some((e) => e.c.some((c) => crit.has(c)));
      if (!guard.choiceRecorded) unmet.choice = 'required';
      if (!guard.tasksDone) {
        unmet.tasks = 'required';
        for (const t of openTasks.slice(0, 20))
          unmet[`/tasks/${t.id}`] =
            `Still ${t.status.replace('_', ' ')}: finish it, or drop it with a reason.`;
      }
      if (!guard.evidenceMapped) unmet.evidence = 'required';
    }
    return { guard, unmet };
  }

  private event(
    tx: Tx,
    s: Pick<StageRow, 'id' | 'problemId'>,
    e: {
      type?: string;
      from: string | null;
      to: string;
      actorId: string | null;
      reason?: string | null;
      payload: Record<string, unknown>;
      now: Date;
    },
  ) {
    return tx.insert(stageEvent).values({
      id: this.ids.next(),
      stageId: s.id,
      problemId: s.problemId,
      type: e.type ?? 'state_changed',
      actorId: e.actorId,
      fromState: e.from,
      toState: e.to,
      reason: e.reason ?? null,
      payload: e.payload,
      originNodeId: config.nodeId,
      protocolVersion: PROTOCOL_VERSION,
      occurredAt: e.now,
    });
  }
}

const pick = (o: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

/** Unresolved required stages that are all blocked or behind a blocked stage; empty when any can still proceed. */
function stuckStages(plan: StagePlan, states: StageStates): string[] {
  const byId = new Map(plan.stages.map((s) => [s.id, s]));
  const behindBlock = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    return (
      states[id] === 'blocked' ||
      (byId.get(id)?.dependsOn.some((d) => behindBlock(d, seen)) ?? false)
    );
  };
  const open = plan.stages.filter((s) => s.required && !settled(states[s.id]));
  return open.length && open.every((s) => behindBlock(s.id))
    ? open.map((s) => s.id)
    : [];
}
