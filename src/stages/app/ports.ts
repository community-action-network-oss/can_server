import { Injectable } from '@nestjs/common';
import type { Tx } from '../../db/tx.js';
import { newId } from '../../domain/ids.js';

/** Creates the contribution behind a stage option. 04-u02 implements it; the fake keeps options pending. */
export interface ContributionPort {
  create(i: {
    problemId: string;
    stageId: string;
    authorId: string;
    type: 'proposed_solution';
    content: Record<string, unknown>;
  }): Promise<{ contributionId: string; status: 'pending' | 'public' }>;
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

/** Required tasks of a stage (05-u01). The fake says done, so ST04 does not wait on tasks that cannot exist yet. */
export interface TaskPort {
  requiredDone(tx: Tx, stageId: string): Promise<boolean>;
}
export const TASK_PORT = Symbol('TaskPort');
@Injectable()
export class FakeTasks implements TaskPort {
  async requiredDone() {
    return true;
  }
}

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
