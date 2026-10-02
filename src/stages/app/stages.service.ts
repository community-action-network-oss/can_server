import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { config } from '../../config.js';
import { DB, type Db } from '../../db/db.module.js';
import {
  account,
  acceptanceCriterion,
  problem,
  stage,
  stageChoice,
  stageEvent,
  stageEvidence,
  stageOption,
} from '../../db/schema.js';
import { withTransaction, type Tx } from '../../db/tx.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';
import { activeLabel } from '../../domain/lifecycle/vocabulary.js';
import type { State } from '../../domain/lifecycle/vocabulary.js';
import { ApiException } from '../../platform/errors.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import type { AuthContext } from '../../platform/security/decorators.js';
import { ContentSchemaNotFound } from '../../policy/domain/pack.js';
import {
  StructuredContentService,
  type SchemaStamp,
} from '../../policy/app/structured-content.service.js';
import {
  allowedContributionTypes,
  allowedForProblemLevel,
} from '../domain/contribution-matrix.js';
import { problemChip } from '../domain/gating.js';
import { topoOrder } from '../domain/plan.js';
import { STAGE_CHIP, type StageState } from '../domain/types.js';
import { visibleToViewer } from '../infra/stage-plan.repo.js';
import {
  CHOICE_GATE,
  CONTRIBUTION_PORT,
  type ChoiceGatePort,
  type ContributionPort,
} from './ports.js';
import {
  STAGE_PLAN_REPO,
  type StagePlanRepository,
} from './stage-plan.repository.js';
import type { WireChoice, WireEvidence, WireOption } from './plan-wire.js';

const UUID = /^[0-9a-f-]{36}$/i;
const nf = () => new ApiException(404, 'not_found', 'Not found.');
const uid = (id: string) => {
  if (!UUID.test(id)) throw nf();
  return id;
};
const bad = (path: string, msg: string) =>
  new ApiException(400, 'validation_failed', 'Some answers need attention.', {
    [path]: msg,
  });
const pin = (s: SchemaStamp | null) => ({
  schemaId: s?.schemaId ?? null,
  schemaVersion: s?.schemaVersion ?? null,
  schemaHash: s?.schemaHash ?? null,
});

export interface Body {
  content: Record<string, unknown>;
  schemaVersion?: string;
  schemaHash?: string;
}
type StageRow = typeof stage.$inferSelect;
type ProblemRow = typeof problem.$inferSelect;
type Viewer = Pick<AuthContext, 'accountId' | 'role'>;

@Injectable()
export class StagesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(STAGE_PLAN_REPO) private readonly plans: StagePlanRepository,
    @Inject(StructuredContentService)
    private readonly structured: StructuredContentService,
    @Inject(CONTRIBUTION_PORT) private readonly contributions: ContributionPort,
    @Inject(CHOICE_GATE) private readonly gate: ChoiceGatePort,
  ) {}

  // ---- reads ----

  async map(problemId: string, viewerId: string | null) {
    const l = await this.plans.listForViewer(uid(problemId), viewerId);
    if (!l) throw nf();
    const { plan, states, rows } = l;
    const byId = new Map(plan.stages.map((s) => [s.id, s]));
    const rowOf = new Map(rows.map((r) => [r.id, r]));
    const evid = await this.evidenceByStage(rows.map((r) => r.id));
    const chip = problemChip(plan, states);
    return {
      problemId,
      problemState: l.problem.state,
      planVersion: l.problem.planVersion,
      label: l.problem.state === 'active' ? activeLabel(chip) : null,
      activeStages: chip?.kind === 'one' ? 1 : (chip?.n ?? 0),
      // topoOrder: the graph and the list are drawn from the same sequence.
      stages: topoOrder(plan).map((id) => {
        const s = byId.get(id)!;
        const r = rowOf.get(id)!;
        const hit = evid.get(id) ?? new Set<string>();
        return {
          id,
          name: r.name,
          label: s.name,
          goal: s.goal,
          state: states[id],
          chip: STAGE_CHIP[states[id]],
          decisionMethod: s.decisionMethod,
          required: s.required,
          needsChoice: s.needsChoice,
          dependsOn: s.dependsOn,
          current: states[id] === 'active' || states[id] === 'resolving',
          ordinal: r.ordinal,
          criteriaTotal: s.criteria.length,
          criteriaWithEvidence: s.criteria.filter((c) => hit.has(c.id)).length,
        };
      }),
      edges: plan.stages.flatMap((s) =>
        s.dependsOn.map((d) => ({ from: d, to: s.id })),
      ),
      finalCriteria: plan.finalCriteria.map((c, i) => ({
        ref: i + 1,
        statement: c.statement,
        measure: c.measure,
        deadline: c.deadline ?? null,
      })),
    };
  }

  private async evidenceByStage(ids: string[]) {
    const out = new Map<string, Set<string>>();
    if (!ids.length) return out;
    const rows = await this.db
      .select({ stageId: stageEvidence.stageId, c: stageEvidence.criteriaIds })
      .from(stageEvidence)
      .where(inArray(stageEvidence.stageId, ids));
    for (const r of rows) {
      const set = out.get(r.stageId) ?? new Set<string>();
      r.c.forEach((c) => set.add(c));
      out.set(r.stageId, set);
    }
    return out;
  }

  async workspace(stageId: string, viewerId: string | null) {
    const { s, p } = await this.find(this.db, stageId, viewerId);
    const crits = await this.criteria(this.db, s.id);
    const options = await this.db
      .select({ o: stageOption, handle: account.handle })
      .from(stageOption)
      .innerJoin(account, eq(account.id, stageOption.authorId))
      .where(eq(stageOption.stageId, s.id))
      .orderBy(asc(stageOption.createdAt));
    const [choice] = await this.liveChoice(this.db, s.id);
    const ev = await this.db
      .select({ e: stageEvidence, handle: account.handle })
      .from(stageEvidence)
      .innerJoin(account, eq(account.id, stageEvidence.submittedBy))
      .where(eq(stageEvidence.stageId, s.id))
      .orderBy(asc(stageEvidence.createdAt));
    const hit = new Set(ev.flatMap((r) => r.e.criteriaIds));
    const refOf = new Map(crits.map((c, i) => [c.id, i + 1]));
    const state = s.state as StageState;
    return {
      id: s.id,
      problemId: p.id,
      name: s.name,
      label: s.label ?? s.name,
      goal: s.goal,
      state,
      chip: STAGE_CHIP[state],
      decisionMethod: s.decisionMethod,
      required: s.required,
      needsChoice: s.needsChoice,
      planVersion: s.planVersion,
      criteria: crits.map((c, i) => ({
        ref: i + 1,
        id: c.id,
        statement: c.statement,
        measure: c.measure,
        target: c.target,
        evidenceHint: c.evidenceHint,
        deadline: c.deadline,
        hasEvidence: hit.has(c.id),
      })),
      options: options
        .filter((r) => r.o.status === 'public' || r.o.authorId === viewerId)
        .map((r) => optionDto(r.o, r.handle)),
      choice: choice ? choiceDto(choice) : null,
      tasks: [] as unknown[], // ponytail: tasks belong to a later unit
      evidence: ev.map((r) => ({
        id: r.e.id,
        url: r.e.url,
        description: r.e.claimText,
        criterionRefs: r.e.criteriaIds.map((c) => refOf.get(c) ?? 0),
        authorHandle: r.handle,
        tier: r.e.tier,
        createdAt: r.e.createdAt.toISOString(),
      })),
      allowedContributionTypes: [...allowedContributionTypes(state)],
    };
  }

  async getOption(id: string, viewerId: string | null) {
    const [r] = await this.db
      .select({ o: stageOption, handle: account.handle, s: stage })
      .from(stageOption)
      .innerJoin(account, eq(account.id, stageOption.authorId))
      .innerJoin(stage, eq(stage.id, stageOption.stageId))
      .where(eq(stageOption.id, uid(id)));
    if (!r) throw nf();
    await this.find(this.db, r.s.id, viewerId); // 404 when the problem is private
    if (r.o.status !== 'public' && r.o.authorId !== viewerId) throw nf();
    return optionDto(r.o, r.handle);
  }

  // ---- writes ----

  async addOption(stageId: string, a: Viewer, b: Body) {
    return withTransaction(this.db, async (tx) => {
      const { s, p } = await this.lock(tx, stageId, a.accountId);
      if (
        !allowedForProblemLevel(p.state as State).includes('proposed_solution')
      )
        throw new ApiException(
          409,
          'problem_not_open',
          'This problem is not taking options now.',
        );
      if (
        !allowedContributionTypes(s.state as StageState).includes(
          'proposed_solution',
        )
      )
        throw new ApiException(
          409,
          'stage_closed',
          'This stage is not taking options now.',
        );
      const stamp = await this.validate(tx, 'stage_option', b);
      const c = b.content as unknown as WireOption;
      await this.checkOption(tx, s, c);
      const made = await this.contributions.create({
        problemId: p.id,
        stageId: s.id,
        authorId: a.accountId,
        type: 'proposed_solution',
        content: b.content,
      });
      const now = this.clock.now();
      const [row] = await tx
        .insert(stageOption)
        .values({
          id: this.ids.next(),
          stageId: s.id,
          contributionId: made.contributionId,
          authorId: a.accountId,
          mechanism: String(c.mechanism ?? ''),
          risks: String(c.risks_and_rights_impact ?? ''),
          content: b.content,
          ...pin(stamp),
          status: made.status,
          forLaterStage: s.state === 'planned' || s.state === 'ready',
          createdAt: now,
        })
        .returning();
      await this.event(tx, s, 'option_added', a.accountId, {
        optionId: row.id,
      });
      return optionDto(row, await this.handle(tx, a.accountId));
    });
  }

  async updateOption(id: string, a: Viewer, b: Body) {
    return withTransaction(this.db, async (tx) => {
      const [o0] = await tx
        .select({ stageId: stageOption.stageId })
        .from(stageOption)
        .where(eq(stageOption.id, uid(id)));
      if (!o0) throw nf();
      const { s } = await this.lock(tx, o0.stageId, a.accountId);
      const [o] = await tx
        .select()
        .from(stageOption)
        .where(eq(stageOption.id, id))
        .for('update');
      if (o.authorId !== a.accountId) throw nf(); // not yours: same answer as unknown
      if (
        !['pending', 'public'].includes(o.status) ||
        (o.status !== 'pending' && s.state !== 'active')
      )
        throw new ApiException(
          409,
          'conflict',
          'This option can no longer be edited.',
        );
      const stamp = await this.validate(tx, 'stage_option', b);
      const c = b.content as unknown as WireOption;
      await this.checkOption(tx, s, c);
      const [row] = await tx
        .update(stageOption)
        .set({
          mechanism: String(c.mechanism ?? ''),
          risks: String(c.risks_and_rights_impact ?? ''),
          content: b.content,
          ...pin(stamp),
        })
        .where(eq(stageOption.id, id))
        .returning();
      await this.event(tx, s, 'option_updated', a.accountId, { optionId: id });
      return optionDto(row, await this.handle(tx, a.accountId));
    });
  }

  async choose(stageId: string, a: Viewer, b: Body) {
    return withTransaction(this.db, async (tx) => {
      const { s, p } = await this.lock(tx, stageId, a.accountId);
      if (!this.mayDecide(s, p, a))
        throw new ApiException(
          403,
          'not_permitted',
          'You cannot record the choice for this stage.',
        );
      this.requireActive(s, p);
      if (!s.needsChoice)
        throw new ApiException(
          409,
          'conflict',
          'This stage does not need a choice.',
        );
      const [live] = await this.liveChoice(tx, s.id);
      if (live)
        throw new ApiException(
          409,
          'conflict',
          'A choice is already recorded. Withdraw it first.',
        );
      const stamp = await this.validate(tx, 'stage_choice', b);
      const c = b.content as unknown as WireChoice;
      if (c.stage_ref !== s.name)
        throw bad('/stage_ref', 'Must name this stage.');
      if (c.decision_method !== s.decisionMethod)
        throw bad('/decision_method', 'Must match the stage decision method.');
      const optionIds = c.chosen_option_ids ?? [];
      if (!optionIds.length && !c.steps?.length)
        throw bad('/chosen_option_ids', 'Pick an option or list steps.');
      if (optionIds.length) {
        const ok = await tx
          .select({ id: stageOption.id })
          .from(stageOption)
          .where(
            and(
              eq(stageOption.stageId, s.id),
              eq(stageOption.status, 'public'),
              inArray(
                stageOption.id,
                optionIds.filter((x) => UUID.test(x)),
              ),
            ),
          );
        if (ok.length !== new Set(optionIds).size)
          throw bad(
            '/chosen_option_ids',
            'Every option must be a public option of this stage.',
          );
      }
      const g = await this.gate.check({
        problemId: p.id,
        stageId: s.id,
        content: b.content,
      });
      if (g.result !== 'passed')
        throw new ApiException(
          409,
          g.result === 'held' ? 'gate_held' : 'gate_blocked',
          g.result === 'held'
            ? 'The check could not finish. Nothing was recorded; try again later.'
            : 'The check did not pass. Nothing was recorded.',
        );
      const [row] = await tx
        .insert(stageChoice)
        .values({
          id: this.ids.next(),
          stageId: s.id,
          optionIds,
          steps: c.steps ?? null,
          decisionMethod: c.decision_method,
          deciderId: a.accountId,
          authority: c.authority ?? '',
          rationale: c.rationale ?? '',
          dissentNotes: c.dissent_notes ?? null,
          content: b.content,
          ...pin(stamp),
          gateResult: g,
          createdAt: this.clock.now(),
        })
        .returning();
      await this.event(tx, s, 'choice_recorded', a.accountId, {
        choiceId: row.id,
      });
      return choiceDto(row);
    });
  }

  async withdrawChoice(stageId: string, a: Viewer) {
    await withTransaction(this.db, async (tx) => {
      const { s, p } = await this.lock(tx, stageId, a.accountId);
      if (!this.mayDecide(s, p, a))
        throw new ApiException(
          403,
          'not_permitted',
          'You cannot withdraw the choice for this stage.',
        );
      this.requireActive(s, p);
      const [live] = await this.liveChoice(tx, s.id);
      if (!live) throw nf();
      await tx
        .update(stageChoice)
        .set({ withdrawnAt: this.clock.now() })
        .where(eq(stageChoice.id, live.id));
      await this.event(tx, s, 'choice_withdrawn', a.accountId, {
        choiceId: live.id,
      });
    });
  }

  async addEvidence(stageId: string, a: Viewer, b: Body) {
    return withTransaction(this.db, async (tx) => {
      const { s, p } = await this.lock(tx, stageId, a.accountId);
      // STAGE-GATE-1 and STAGE-PREP-1: ahead contributions are never evidence.
      if (s.state === 'planned' || s.state === 'ready')
        throw new ApiException(409, 'not_ready', 'This stage has not started.');
      if (s.state !== 'active' && s.state !== 'blocked')
        throw new ApiException(
          409,
          'stage_closed',
          'This stage is not taking evidence now.',
        );
      if (!allowedForProblemLevel(p.state as State).includes('evidence'))
        throw new ApiException(
          409,
          'problem_not_open',
          'This problem is not taking evidence now.',
        );
      const stamp = await this.validate(tx, 'stage_evidence', b);
      const c = b.content as unknown as WireEvidence;
      if (c.stage_ref !== s.name)
        throw bad('/stage_ref', 'Must name this stage.');
      const crits = await this.criteria(tx, s.id);
      const crit = Number.isInteger(c.criterion_ref)
        ? crits[c.criterion_ref - 1]
        : undefined;
      if (!crit)
        throw bad(
          '/criterion_ref',
          'Pick a criterion of this stage by its number.',
        );
      const refs = Array.isArray(c.evidence_refs) ? c.evidence_refs : [];
      if (!refs.length) throw bad('/evidence_refs', 'Add at least one link.');
      refs.forEach((r, i) => {
        let ok = false;
        try {
          ok = new URL(r.url).protocol === 'https:';
        } catch {
          /* not a URL */
        }
        if (!ok)
          throw bad(
            `/evidence_refs/${i}/url`,
            'Use a link that starts with https://',
          );
      });
      const now = this.clock.now();
      const rows = await tx
        .insert(stageEvidence)
        .values(
          refs.map((r) => ({
            id: this.ids.next(),
            stageId: s.id,
            url: r.url,
            claimText: String(r.description ?? ''),
            criteriaIds: [crit.id],
            submittedBy: a.accountId,
            content: { ...b.content, evidence_refs: [r] },
            ...pin(stamp),
            createdAt: now,
          })),
        )
        .returning();
      await this.event(tx, s, 'evidence_added', a.accountId, {
        criterionId: crit.id,
        count: rows.length,
      });
      const handle = await this.handle(tx, a.accountId);
      return rows.map((e) => ({
        id: e.id,
        url: e.url,
        description: e.claimText,
        criterionRefs: [c.criterion_ref],
        authorHandle: handle,
        tier: e.tier,
        createdAt: e.createdAt.toISOString(),
      }));
    });
  }

  // ---- helpers ----

  private mayDecide(s: StageRow, p: ProblemRow, a: Viewer) {
    if (s.decisionMethod === 'poster_after_input')
      return p.initiatorId === a.accountId;
    // ponytail: votes and named deciders have no machinery yet; stewards (moderator, admin) record them.
    return a.role === 'moderator' || a.role === 'admin';
  }

  /** STAGE-GATE-1: a planned or ready stage takes no choice. */
  private requireActive(s: StageRow, p: ProblemRow) {
    if (s.state === 'planned' || s.state === 'ready')
      throw new ApiException(409, 'not_ready', 'This stage has not started.');
    if (s.state !== 'active')
      throw new ApiException(409, 'stage_closed', 'This stage is not active.');
    if (p.state !== 'active')
      throw new ApiException(
        409,
        'problem_not_open',
        'This problem is not active.',
      );
  }

  private async find(tx: Tx | Db, stageId: string, viewerId: string | null) {
    const [r] = await tx
      .select({ s: stage, p: problem })
      .from(stage)
      .innerJoin(problem, eq(problem.id, stage.problemId))
      .where(eq(stage.id, uid(stageId)));
    if (!r || !visibleToViewer(r.p, viewerId)) throw nf();
    return r;
  }

  private async lock(tx: Tx, stageId: string, viewerId: string) {
    const [r] = await tx
      .select({ s: stage, p: problem })
      .from(stage)
      .innerJoin(problem, eq(problem.id, stage.problemId))
      .where(eq(stage.id, uid(stageId)))
      .for('update', { of: stage });
    if (!r || !visibleToViewer(r.p, viewerId)) throw nf();
    return r;
  }

  private criteria(tx: Tx | Db, stageId: string) {
    return tx
      .select()
      .from(acceptanceCriterion)
      .where(eq(acceptanceCriterion.stageId, stageId))
      .orderBy(asc(acceptanceCriterion.ordinal));
  }

  private liveChoice(tx: Tx | Db, stageId: string) {
    return tx
      .select()
      .from(stageChoice)
      .where(
        and(eq(stageChoice.stageId, stageId), isNull(stageChoice.withdrawnAt)),
      );
  }

  private async handle(tx: Tx, id: string) {
    const [r] = await tx
      .select({ h: account.handle })
      .from(account)
      .where(eq(account.id, id));
    return r.h;
  }

  /** Pinned content schema when the active pack has one (draft vs submit: these are always submits). */
  private async validate(
    tx: Tx,
    type: string,
    b: Body,
  ): Promise<SchemaStamp | null> {
    let stamp: SchemaStamp;
    try {
      stamp = await this.structured.stamp(tx, type, this.clock.now(), {
        version: b.schemaVersion,
        hash: b.schemaHash,
      });
    } catch (e) {
      // ponytail: a pack without this schema skips validation; every semantic check below still runs.
      if (e instanceof ContentSchemaNotFound) return null;
      throw e;
    }
    await this.structured.validate(tx, type, stamp, b.content, 'submit');
    return stamp;
  }

  private async checkOption(tx: Tx, s: StageRow, c: WireOption) {
    if (c.stage_ref !== s.name)
      throw bad('/stage_ref', 'Must name this stage.');
    const n = (await this.criteria(tx, s.id)).length;
    (c.how_it_meets_stage_criteria ?? []).forEach((h, i) => {
      if (
        !Number.isInteger(h.criterion_ref) ||
        h.criterion_ref < 1 ||
        h.criterion_ref > n
      )
        throw bad(
          `/how_it_meets_stage_criteria/${i}/criterion_ref`,
          'Pick a criterion of this stage by its number.',
        );
    });
  }

  private event(
    tx: Tx,
    s: StageRow,
    type: string,
    actorId: string,
    payload: Record<string, unknown>,
  ) {
    return tx.insert(stageEvent).values({
      id: this.ids.next(),
      stageId: s.id,
      problemId: s.problemId,
      type,
      actorId,
      payload,
      originNodeId: config.nodeId,
      protocolVersion: PROTOCOL_VERSION,
      occurredAt: this.clock.now(),
    });
  }
}

const optionDto = (o: typeof stageOption.$inferSelect, handle: string) => ({
  id: o.id,
  stageId: o.stageId,
  authorHandle: handle,
  status: o.status,
  forLaterStage: o.forLaterStage,
  content: o.content,
  createdAt: o.createdAt.toISOString(),
});
const choiceDto = (c: typeof stageChoice.$inferSelect) => ({
  id: c.id,
  optionIds: c.optionIds,
  steps: c.steps,
  decisionMethod: c.decisionMethod,
  deciderRole: String(
    (c.content as { decider_role?: string }).decider_role ?? '',
  ),
  authority: c.authority,
  rationale: c.rationale,
  dissentNotes: c.dissentNotes,
  gateResult: c.gateResult,
  createdAt: c.createdAt.toISOString(),
});
