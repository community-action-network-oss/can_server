import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray, or } from 'drizzle-orm';
import { config } from '../../config.js';
import { DB, type Db } from '../../db/db.module.js';
import {
  acceptanceCriterion,
  problem,
  stage,
  stageEdge,
} from '../../db/schema.js';
import { withTransaction, type Tx } from '../../db/tx.js';
import { newId } from '../../domain/ids.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';
import {
  isPublicState,
  type State,
} from '../../domain/lifecycle/vocabulary.js';
import { ApiException } from '../../platform/errors.js';
import { validatePlan } from '../domain/plan.js';
import type { StageState, StageStates } from '../domain/types.js';
import type { PlanDraft } from '../app/plan-wire.js';
import type {
  LoadedPlan,
  StagePlanRepository,
} from '../app/stage-plan.repository.js';

type ProblemRow = typeof problem.$inferSelect;

/** Stage rows are private until the problem is published (T04); the poster always sees their own. */
export const visibleToViewer = (
  p: Pick<
    ProblemRow,
    'publishedAt' | 'state' | 'withdrawnPublished' | 'initiatorId' | 'deletedAt'
  >,
  viewerId: string | null,
) =>
  !p.deletedAt &&
  ((!!viewerId && p.initiatorId === viewerId) ||
    (!!p.publishedAt && isPublicState(p.state as State, p.withdrawnPublished)));

const EDITABLE = ['draft', 'needs_revision'];
const toCrit = (r: typeof acceptanceCriterion.$inferSelect) => ({
  id: r.id,
  statement: r.statement,
  measure: r.measure,
  ...(r.target && { target: r.target }),
  ...(r.evidenceHint && { evidenceHint: r.evidenceHint }),
  ...(r.deadline && { deadline: r.deadline }),
});

@Injectable()
export class DrizzleStagePlanRepo implements StagePlanRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async savePlan(problemId: string, plan: PlanDraft): Promise<void> {
    const v = validatePlan(plan);
    if (!v.ok)
      throw new ApiException(
        400,
        'validation_failed',
        'The stage plan has problems.',
        Object.fromEntries(
          v.issues.map((i, n) => [`/stage_plan/${n}`, i.code]),
        ),
      );
    await withTransaction(this.db, async (tx) => {
      const [p] = await tx
        .select()
        .from(problem)
        .where(eq(problem.id, problemId))
        .for('update');
      if (!p) throw new ApiException(404, 'not_found', 'Problem not found.');
      if (!EDITABLE.includes(p.state))
        throw new ApiException(
          409,
          'conflict',
          'The plan can only change while the problem is a draft.',
        );
      await this.clear(tx, problemId);
      const ids = new Map(plan.stages.map((s) => [s.id, newId()]));
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
            planVersion: p.planVersion,
            ordinal,
            ...base,
          })),
        );
      const edges = plan.stages.flatMap((s) =>
        s.dependsOn.map((d) => ({
          stageId: ids.get(s.id)!,
          dependsOnId: ids.get(d)!,
          planVersion: p.planVersion,
        })),
      );
      if (edges.length) await tx.insert(stageEdge).values(edges);
      const crit = (
        c: PlanDraft['finalCriteria'][number],
        ordinal: number,
      ) => ({
        id: newId(),
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
    });
  }

  /** Draft plans have no events or options, so a delete-and-reinsert is safe here. */
  private async clear(tx: Tx, problemId: string) {
    const old = (
      await tx
        .select({ id: stage.id })
        .from(stage)
        .where(eq(stage.problemId, problemId))
    ).map((r) => r.id);
    await tx
      .delete(acceptanceCriterion)
      .where(eq(acceptanceCriterion.problemId, problemId));
    if (!old.length) return;
    await tx
      .delete(acceptanceCriterion)
      .where(inArray(acceptanceCriterion.stageId, old));
    await tx.delete(stageEdge).where(inArray(stageEdge.stageId, old));
    await tx.delete(stage).where(inArray(stage.id, old));
  }

  async loadPlan(problemId: string): Promise<LoadedPlan | null> {
    const [p] = await this.db
      .select()
      .from(problem)
      .where(eq(problem.id, problemId));
    return p ? this.load(p) : null;
  }

  async listForViewer(problemId: string, viewerId: string | null) {
    const [p] = await this.db
      .select()
      .from(problem)
      .where(eq(problem.id, problemId));
    return p && visibleToViewer(p, viewerId) ? this.load(p) : null;
  }

  private async load(p: ProblemRow): Promise<LoadedPlan> {
    const rows = await this.db
      .select()
      .from(stage)
      .where(eq(stage.problemId, p.id))
      .orderBy(asc(stage.ordinal));
    const ids = rows.map((r) => r.id);
    const edges = ids.length
      ? await this.db
          .select()
          .from(stageEdge)
          .where(inArray(stageEdge.stageId, ids))
      : [];
    const crits = await this.db
      .select()
      .from(acceptanceCriterion)
      .where(
        or(
          eq(acceptanceCriterion.problemId, p.id),
          ids.length ? inArray(acceptanceCriterion.stageId, ids) : undefined,
        ),
      );
    const byOrdinal = (a: { ordinal: number }, b: { ordinal: number }) =>
      a.ordinal - b.ordinal;
    return {
      plan: {
        planVersion: p.planVersion,
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
          criteria: crits
            .filter((c) => c.stageId === r.id)
            .sort(byOrdinal)
            .map(toCrit),
        })),
        finalCriteria: crits
          .filter((c) => c.problemId === p.id)
          .sort(byOrdinal)
          .map(toCrit),
      },
      states: Object.fromEntries(
        rows.map((r) => [r.id, r.state as StageState]),
      ) as StageStates,
      rows,
      problem: {
        id: p.id,
        state: p.state,
        initiatorId: p.initiatorId,
        planVersion: p.planVersion,
      },
    };
  }
}
