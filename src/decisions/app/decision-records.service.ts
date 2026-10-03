import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import {
  account,
  decisionRecord,
  legalGateRecord,
  problem,
  stage,
  stageChoice,
} from '../../db/schema.js';
import type { Tx } from '../../db/tx.js';
import { ApiException } from '../../platform/errors.js';
import { ID_GENERATOR, type IdGenerator } from '../../platform/ports.js';
import { visibleToViewer } from '../../stages/infra/stage-plan.repo.js';
import { choiceGateValue, type GateFinding } from '../domain/legal-gate.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nf = () => new ApiException(404, 'not_found', 'Not found.');

/** What a gate run produced (src/stages/app/choice builds it; this service only stores it). */
export interface GateRecordInput {
  outcome: 'clear' | 'blocked';
  findings: GateFinding[];
  constraintText: string | null;
  sourceRef: string | null;
  packVersion: string;
  checkedBy: string;
  checkedAt: Date;
  transitional: boolean;
}

type ChoiceRow = typeof stageChoice.$inferSelect;

/**
 * The decision record is the single source of `choice_gate` (DP-STAGE-RESOLUTION reads it, never user text).
 * Both tables are insert-only: this service has no update or delete path.
 */
@Injectable()
export class DecisionRecordService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /** A clear gate: the record and its legal-gate record, in the caller's transaction with the choice insert. */
  async recordClear(
    tx: Tx,
    i: { problemId: string; choice: ChoiceRow; gate: GateRecordInput },
  ) {
    const id = this.ids.next();
    await tx.insert(decisionRecord).values({
      id,
      problemId: i.problemId,
      stageId: i.choice.stageId,
      stageChoiceId: i.choice.id,
      method: i.choice.decisionMethod,
      rationale: i.choice.rationale,
      decidedBy: i.choice.deciderId,
      authority: i.choice.authority,
      dissentNotes: i.choice.dissentNotes,
      transitional: i.gate.transitional,
      policyVersion: i.gate.packVersion,
      decidedAt: i.choice.createdAt,
    });
    await this.insertGate(tx, i.problemId, i.choice.stageId, id, i.gate);
    return id;
  }

  /** A blocked gate: the gate record stands, no decision record, no choice. */
  async recordBlocked(
    tx: Tx,
    i: { problemId: string; stageId: string; gate: GateRecordInput },
  ) {
    await this.insertGate(tx, i.problemId, i.stageId, null, i.gate);
  }

  private insertGate(
    tx: Tx,
    problemId: string,
    stageId: string,
    decisionRecordId: string | null,
    g: GateRecordInput,
  ) {
    return tx.insert(legalGateRecord).values({
      id: this.ids.next(),
      decisionRecordId,
      problemId,
      stageId,
      findings: g.findings as unknown as Record<string, unknown>[],
      packVersion: g.packVersion,
      outcome: g.outcome,
      constraintText: g.constraintText,
      sourceRef: g.sourceRef,
      checkedBy: g.checkedBy,
      checkedAt: g.checkedAt,
    });
  }

  /** not_needed | recorded | missing, from a live (not withdrawn) record with a clear legal gate. */
  async choiceGate(
    stageId: string,
    needsChoice: boolean,
    tx: Tx | Db = this.db,
  ) {
    const [r] = await tx
      .select({ id: decisionRecord.id })
      .from(decisionRecord)
      .innerJoin(stageChoice, eq(stageChoice.id, decisionRecord.stageChoiceId))
      .innerJoin(
        legalGateRecord,
        eq(legalGateRecord.decisionRecordId, decisionRecord.id),
      )
      .where(
        and(
          eq(decisionRecord.stageId, stageId),
          isNull(stageChoice.withdrawnAt),
          eq(legalGateRecord.outcome, 'clear'),
        ),
      )
      .limit(1);
    return choiceGateValue(needsChoice, !!r);
  }

  /** Public after publish. Every record of the stage, oldest first; a withdrawn choice keeps its record. */
  async read(stageId: string, viewerId: string | null) {
    if (!UUID.test(stageId)) throw nf();
    const [r] = await this.db
      .select({ s: stage, p: problem })
      .from(stage)
      .innerJoin(problem, eq(problem.id, stage.problemId))
      .where(eq(stage.id, stageId));
    if (!r || !visibleToViewer(r.p, viewerId)) throw nf();
    const rows = await this.db
      .select({
        d: decisionRecord,
        g: legalGateRecord,
        withdrawnAt: stageChoice.withdrawnAt,
        handle: account.handle,
      })
      .from(decisionRecord)
      .innerJoin(stageChoice, eq(stageChoice.id, decisionRecord.stageChoiceId))
      .innerJoin(account, eq(account.id, decisionRecord.decidedBy))
      .innerJoin(
        legalGateRecord,
        eq(legalGateRecord.decisionRecordId, decisionRecord.id),
      )
      .where(eq(decisionRecord.stageId, stageId))
      .orderBy(asc(decisionRecord.decidedAt), asc(decisionRecord.id));
    return {
      stageId,
      choiceGate: await this.choiceGate(stageId, r.s.needsChoice),
      items: rows.map(({ d, g, withdrawnAt, handle }) => ({
        id: d.id,
        stageChoiceId: d.stageChoiceId,
        method: d.method,
        rationale: d.rationale,
        deciderHandle: handle,
        authority: d.authority,
        dissentNotes: d.dissentNotes,
        transitional: d.transitional,
        policyVersion: d.policyVersion,
        decidedUnder: d.policyVersion
          ? `Decided under policy ${d.policyVersion}`
          : null,
        transitionalNote:
          d.policyVersion && d.transitional
            ? `Policy ${d.policyVersion}, transitional stewardship`
            : null,
        withdrawn: !!withdrawnAt,
        decidedAt: d.decidedAt.toISOString(),
        legalGate: {
          outcome: g.outcome,
          packVersion: g.packVersion,
          checkedAt: g.checkedAt.toISOString(),
          findings: g.findings,
        },
      })),
    };
  }
}
