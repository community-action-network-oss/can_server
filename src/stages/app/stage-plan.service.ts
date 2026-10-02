import { eq, inArray } from 'drizzle-orm';
import { config } from '../../config.js';
import {
  acceptanceCriterion,
  problem,
  stage,
  stageEdge,
  stageEvent,
} from '../../db/schema.js';
import type { Tx } from '../../db/tx.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';
import { planShapeErrors } from '../../problems/domain/preparation.js';
import { ApiException } from '../../platform/errors.js';
import type { IdGenerator } from '../../platform/ports.js';
import { validatePlan } from '../domain/plan.js';
import { ONE_STAGE } from '../domain/templates.js';
import {
  planFromWire,
  type PlanDraft,
  type StageDraft,
  type WireFinalCriterion,
  type WireStageNode,
} from './plan-wire.js';

/**
 * Publication of the stage plan (T04, ST01 to ST03). Runs inside the transition transaction; it never opens its own
 * (a second transaction would wait on the problem row lock the engine holds).
 */
export class StagePlanService {
  constructor(private readonly ids: IdGenerator) {}

  /**
   * The plan is rebuilt from the draft content, so the stored rows can never drift from what the reviewers saw.
   * A problem with no final criteria and no stage rows is refused (CRITERIA-1).
   */
  async publish(tx: Tx, problemId: string, now: Date): Promise<void> {
    const [p] = await tx
      .select()
      .from(problem)
      .where(eq(problem.id, problemId));
    if (!p) throw new ApiException(404, 'not_found', 'Problem not found.');
    const content = (p.content ?? {}) as Record<string, unknown>;
    const finals = (content.final_acceptance_criteria ??
      []) as WireFinalCriterion[];
    const nodes = (content.stage_plan ?? []) as WireStageNode[];
    if (finals.length) {
      if (Object.keys(planShapeErrors(content)).length)
        throw new ApiException(
          409,
          'invalid_transition',
          'The stage plan is not complete.',
        );
      const plan = this.planOf(nodes, finals, p.planVersion);
      // Fail closed: a plan that cannot publish keeps the problem in review.
      if (!validatePlan(plan).ok)
        throw new ApiException(
          409,
          'invalid_transition',
          'The stage plan is not valid.',
        );
      await this.rebuild(tx, problemId, plan, p.planVersion);
    }
    const rows = await tx
      .select()
      .from(stage)
      .where(eq(stage.problemId, problemId));
    // CRITERIA-1 on the publish path too: no final criteria and no stored plan means nothing can be published.
    if (!rows.length)
      throw new ApiException(
        409,
        'invalid_transition',
        'The problem has no acceptance criteria.',
      );
    const withPred = new Set(
      (
        await tx
          .select()
          .from(stageEdge)
          .where(
            inArray(
              stageEdge.stageId,
              rows.map((r) => r.id),
            ),
          )
      ).map((e) => e.stageId),
    );
    const log = (
      s: (typeof rows)[number],
      from: string | null,
      to: string,
      id: string,
    ) =>
      tx.insert(stageEvent).values({
        id: this.ids.next(),
        stageId: s.id,
        problemId,
        type: 'state_changed',
        actorId: null,
        fromState: from,
        toState: to,
        payload: { transitionId: id, planVersion: p.planVersion },
        originNodeId: config.nodeId,
        protocolVersion: PROTOCOL_VERSION,
        occurredAt: now,
      });
    for (const s of rows) {
      if (s.state !== 'planned') continue;
      await log(s, null, 'planned', 'ST01');
      if (withPred.has(s.id)) continue;
      // ST02: no predecessor. ST03: a stage that starts by itself (the problem is already active in this transaction).
      await log(s, 'planned', 'ready', 'ST02');
      let to = 'ready';
      if (s.autoStart) {
        await log(s, 'ready', 'active', 'ST03');
        to = 'active';
      }
      await tx.update(stage).set({ state: to }).where(eq(stage.id, s.id));
    }
  }

  /** The stored plan, or the implicit single stage whose criteria are the final criteria. */
  private planOf(
    nodes: WireStageNode[],
    finals: WireFinalCriterion[],
    planVersion: number,
  ): PlanDraft {
    const plan = planFromWire(nodes, finals, planVersion);
    if (nodes.length) return plan;
    const one = ONE_STAGE(plan.finalCriteria);
    return { ...plan, stages: one.stages as StageDraft[] };
  }

  private async rebuild(
    tx: Tx,
    problemId: string,
    plan: PlanDraft,
    planVersion: number,
  ) {
    const old = (
      await tx
        .select({ id: stage.id })
        .from(stage)
        .where(eq(stage.problemId, problemId))
    ).map((r) => r.id);
    await tx
      .delete(acceptanceCriterion)
      .where(eq(acceptanceCriterion.problemId, problemId));
    if (old.length) {
      await tx
        .delete(acceptanceCriterion)
        .where(inArray(acceptanceCriterion.stageId, old));
      await tx.delete(stageEdge).where(inArray(stageEdge.stageId, old));
      await tx.delete(stage).where(inArray(stage.id, old));
    }
    const ids = new Map(plan.stages.map((s) => [s.id, this.ids.next()]));
    const base = {
      originNodeId: config.nodeId,
      protocolVersion: PROTOCOL_VERSION,
    };
    if (plan.stages.length)
      await tx.insert(stage).values(
        plan.stages.map((s, ordinal) => ({
          id: ids.get(s.id)!,
          problemId,
          name: s.id,
          label: s.name,
          goal: s.goal,
          decisionMethod: s.decisionMethod,
          required: s.required,
          needsChoice: s.needsChoice,
          autoStart: s.autoStart,
          planVersion,
          ordinal,
          ...base,
        })),
      );
    const edges = plan.stages.flatMap((s) =>
      s.dependsOn.map((d) => ({
        stageId: ids.get(s.id)!,
        dependsOnId: ids.get(d)!,
        planVersion,
      })),
    );
    if (edges.length) await tx.insert(stageEdge).values(edges);
    const crit = (c: PlanDraft['finalCriteria'][number], ordinal: number) => ({
      id: this.ids.next(),
      statement: c.statement,
      measure: c.measure,
      target: c.target ?? null,
      evidenceHint: c.evidenceHint ?? null,
      deadline: c.deadline ?? null,
      ordinal,
    });
    const rows = [
      ...plan.finalCriteria.map((c, i) => ({
        ...crit(c, i),
        problemId,
        stageId: null,
      })),
      ...plan.stages.flatMap((s) =>
        s.criteria.map((c, i) => ({
          ...crit(c, i),
          problemId: null,
          stageId: ids.get(s.id)!,
        })),
      ),
    ];
    if (rows.length) await tx.insert(acceptanceCriterion).values(rows);
  }
}
