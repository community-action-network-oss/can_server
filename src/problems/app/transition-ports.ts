import type { Tx } from '../../db/tx.js';
import type {
  ActorKind,
  ConditionName,
  TransitionId,
} from '../../domain/lifecycle/table.js';
import type { State } from '../../domain/lifecycle/vocabulary.js';

/** Review facts the T04 conditions need. Supplied by the review unit; the engine never counts reviews. */
export interface ReviewFacts {
  get(
    tx: Tx,
    problemId: string,
  ): Promise<
    Pick<
      Record<ConditionName, boolean>,
      'atLeastOneCompletedReview' | 'reviewQuorumMetOrPosterOverride'
    >
  >;
}
export const REVIEW_FACTS = Symbol('ReviewFacts');
/** Fail closed until the review unit plugs in (PUB-FAILCLOSED-1): no review facts means no T04. */
export class NoReviewFacts implements ReviewFacts {
  async get() {
    return {
      atLeastOneCompletedReview: false,
      reviewQuorumMetOrPosterOverride: false,
    };
  }
}

export interface EffectContext {
  problemId: string;
  transitionId: TransitionId;
  from: State;
  to: State;
  actor: { kind: ActorKind; id: string | null };
  fields: Readonly<Record<string, unknown>>;
  runId?: string;
  now: Date;
}
export interface TransitionEffect {
  on: TransitionId[];
  /** Runs inside the transition transaction after the row changed; throwing rolls everything back. */
  run(tx: Tx, ctx: EffectContext): Promise<void>;
}
export class TransitionEffects {
  private readonly effects: TransitionEffect[] = [];
  register(e: TransitionEffect): void {
    this.effects.push(e);
  }
  async runFor(tx: Tx, ctx: EffectContext): Promise<void> {
    for (const e of this.effects)
      if (e.on.includes(ctx.transitionId)) await e.run(tx, ctx);
  }
}

/** Told after commit. Default does nothing; the email adapter (03-u11) and outcome applier (09-u23) plug in. */
export interface DecisionNotifier {
  notify(n: {
    problemId: string;
    kind: 'applied' | 'proposed' | 'declined';
    transitionId?: string;
    to?: string;
  }): Promise<void>;
}
export const DECISION_NOTIFIER = Symbol('DecisionNotifier');
export class NoopDecisionNotifier implements DecisionNotifier {
  async notify(): Promise<void> {}
}

/**
 * What the review module (12-u03) does when preparation moves. Every call runs inside the caller's transaction.
 * Default does nothing; bind REVIEW_HOOKS to plug the module in. Paths are review_recommendation paths.
 */
export interface ReviewHooks {
  /** T01: the problem enters the volunteer review queue. */
  enterQueue(tx: Tx, problemId: string): Promise<void>;
  /** The poster edited while in_review: mark recommendations on these paths "changed since". Never reopens them. */
  markChanged(
    tx: Tx,
    problemId: string,
    version: number,
    paths: string[],
  ): Promise<void>;
  /** T03: reopen recommendations whose path changed. */
  reopen(tx: Tx, problemId: string, paths: string[]): Promise<void>;
  /** T05, T06, T07: volunteer access ends. */
  endAccess(tx: Tx, problemId: string): Promise<void>;
}
export const REVIEW_HOOKS = Symbol('ReviewHooks');
export class NoopReviewHooks implements ReviewHooks {
  async enterQueue(): Promise<void> {}
  async markChanged(): Promise<void> {}
  async reopen(): Promise<void> {}
  async endAccess(): Promise<void> {}
}
