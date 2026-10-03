import { Injectable } from '@nestjs/common';
import type { Tx } from '../../db/tx.js';
import type { GateRecordInput } from '../../decisions/app/decision-records.service.js';
import { newId } from '../../domain/ids.js';

/** Creates the contribution behind a stage option or evidence submission (both are D-85 replies). 04-u02 implements it; the fake keeps options pending. */
export interface ContributionPort {
  /** Pass the caller's `tx`: the stage row is locked there, so a second connection would wait on it forever. */
  create(
    i: {
      problemId: string;
      stageId: string;
      authorId: string;
      type: 'proposed_solution' | 'evidence' | 'progress_update';
      content: Record<string, unknown>;
    },
    tx?: Tx,
  ): Promise<{ contributionId: string; status: 'pending' | 'public' }>;
}
export const CONTRIBUTION_PORT = Symbol('ContributionPort');

/** CHOICE-GATE: DP-DECISION-RECORD and DP-LEGALITY (04-u05 and plan 09). `held` means the run could not finish. */
export interface ChoiceGatePort {
  check(i: {
    problemId: string;
    stageId: string;
    content: Record<string, unknown>;
  }): Promise<{
    result: 'passed' | 'blocked' | 'needs_review' | 'held';
    layer: 'constitution' | 'jurisdiction' | 'both';
    /** The layered legal check to store as the decision record (absent for a gate that records nothing). */
    gate?: GateRecordInput;
    /** Field hints for `needs_review`. */
    hint?: Record<string, string>;
  }>;
}
export const CHOICE_GATE = Symbol('ChoiceGatePort');

@Injectable()
export class FakeContributions implements ContributionPort {
  async create() {
    return { contributionId: newId(), status: 'pending' as const };
  }
}
@Injectable()
export class PassingChoiceGate implements ChoiceGatePort {
  async check() {
    return { result: 'passed' as const, layer: 'both' as const };
  }
}

/** Required tasks of a stage that are not done or dropped (05-u01). ST04 needs the list empty. */
export interface TaskPort {
  openRequired(
    tx: Tx,
    stageId: string,
  ): Promise<{ id: string; status: string }[]>;
}
export const TASK_PORT = Symbol('TaskPort');

/** The BLOCKER-1 record of ST07 (05-u03 stores it in `stage_blocker`). Returns what the `stage_event` payload keeps. */
export interface BlockerRecordPort {
  record(
    tx: Tx,
    i: { stageId: string; record: Record<string, unknown> },
  ): Promise<Record<string, unknown>>;
}
export const BLOCKER_RECORD_PORT = Symbol('BlockerRecordPort');
@Injectable()
export class EventBlockerRecords implements BlockerRecordPort {
  async record(_tx: Tx, i: { record: Record<string, unknown> }) {
    return { blocker: i.record };
  }
}
