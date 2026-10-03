import { Inject, Injectable } from '@nestjs/common';
import { PolicyStore } from '../../policy/app/policy-store.js';
import { CLASSIC_5, ONE_STAGE } from '../domain/templates.js';
import type { StagePlan } from '../domain/types.js';
import {
  planFromWire,
  type WireFinalCriterion,
  type WireStageNode,
} from './plan-wire.js';

const META = [
  { id: 'classic-5', name: 'Five steps', plan: () => CLASSIC_5 },
  {
    id: 'one-stage',
    name: 'One stage',
    plan: () => ONE_STAGE(CLASSIC_5.finalCriteria),
  },
] as const;

@Injectable()
export class StageTemplatesService {
  constructor(@Inject(PolicyStore) private readonly store: PolicyStore) {}

  /**
   * Wording from the active pack wins: `limits.stage_templates.<id>.{stage_plan, final_acceptance_criteria}` in the
   * can_policy wire shape. ponytail: that key is a guess until can_policy ships template files; a missing or malformed one falls back to the domain constants.
   */
  list() {
    return {
      items: META.map((m) => {
        const plan = this.fromPack(m.id) ?? m.plan();
        return {
          id: m.id,
          name: m.name,
          stages: plan.stages.map((s) => ({
            name: s.id,
            label: s.name,
            goal: s.goal,
            decisionMethod: s.decisionMethod,
            dependsOn: s.dependsOn,
            needsChoice: s.needsChoice,
            required: s.required,
            criteria: s.criteria.map((c) => ({
              statement: c.statement,
              measure: c.measure,
            })),
          })),
          finalCriteria: plan.finalCriteria.map((c) => ({
            statement: c.statement,
            measure: c.measure,
          })),
        };
      }),
    };
  }

  private fromPack(id: string): StagePlan | null {
    try {
      const t = (
        this.store.active('default').limits.stage_templates as
          Record<string, unknown> | undefined
      )?.[id] as
        | {
            stage_plan?: WireStageNode[];
            final_acceptance_criteria?: WireFinalCriterion[];
          }
        | undefined;
      if (!Array.isArray(t?.stage_plan) || !t.stage_plan.length) return null;
      const finals = Array.isArray(t.final_acceptance_criteria)
        ? t.final_acceptance_criteria
        : [];
      return planFromWire(t.stage_plan, finals);
    } catch {
      return null;
    }
  }
}
