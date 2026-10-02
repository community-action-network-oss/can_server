import type { StagePlanService } from '../../stages/app/stage-plan.service.js';
import type { ReviewHooks, TransitionEffect } from './transition-ports.js';

/**
 * The preparation hooks on the transition engine (12-u04). `hooks` is read at call time so a bound review module is picked up.
 * T04 publishes the stage plan in the same transaction: a throw leaves the problem in review with every stage unchanged.
 */
export const preparationEffects = (
  plans: StagePlanService,
  hooks: () => ReviewHooks,
): TransitionEffect[] => [
  { on: ['T01'], run: (tx, c) => hooks().enterQueue(tx, c.problemId) },
  { on: ['T04'], run: (tx, c) => plans.publish(tx, c.problemId, c.now) },
  {
    on: ['T05', 'T06', 'T07'],
    run: (tx, c) => hooks().endAccess(tx, c.problemId),
  },
];
