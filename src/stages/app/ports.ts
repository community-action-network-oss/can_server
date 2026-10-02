import { Injectable } from '@nestjs/common';
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
