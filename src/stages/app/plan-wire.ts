// Mapping layer: can_policy wire shapes (snake_case) <-> stage domain (camelCase). Pure.
// criterion_ref is a 1-based position in its stage's criteria; stage refs are the plan slug.
import type {
  Criterion,
  DecisionMethod,
  Stage,
  StagePlan,
} from '../domain/types.js';

export type CriterionX = Criterion & { deadline?: string };
export type StageDraft = Omit<Stage, 'criteria'> & { criteria: CriterionX[] };
/** A StagePlan that also carries deadlines. Stage.id is the slug until the repository assigns ids. */
export type PlanDraft = Omit<StagePlan, 'stages' | 'finalCriteria'> & {
  stages: StageDraft[];
  finalCriteria: CriterionX[];
};

export interface WireCriterion {
  statement: string;
  measure: string;
  target?: string;
  evidence_hint?: string;
  deadline?: string;
}
export interface WireStageNode {
  name: string;
  label?: string;
  goal: string;
  acceptance_criteria: WireCriterion[];
  decision_method?: DecisionMethod;
  depends_on?: string[];
  required?: boolean;
  needs_choice?: boolean;
  auto_start?: boolean;
}
/** problem.final_acceptance_criteria items: how_observed is the measure. */
export interface WireFinalCriterion {
  statement: string;
  how_observed: string;
  deadline?: string;
}

const crit = (id: string, c: WireCriterion): CriterionX => ({
  id,
  statement: c.statement,
  measure: c.measure,
  ...(c.target !== undefined && { target: c.target }),
  ...(c.evidence_hint !== undefined && { evidenceHint: c.evidence_hint }),
  ...(c.deadline !== undefined && { deadline: c.deadline }),
});

/** Defaults follow the stage_node schema. Unknown depends_on slugs are kept so validatePlan reports dangling_edge. */
export function planFromWire(
  nodes: WireStageNode[],
  finalCriteria: WireFinalCriterion[],
  planVersion = 1,
): PlanDraft {
  return {
    planVersion,
    stages: nodes.map((n) => ({
      id: n.name,
      name: n.label ?? n.name,
      goal: n.goal,
      decisionMethod: n.decision_method ?? 'poster_after_input',
      required: n.required ?? true,
      needsChoice: n.needs_choice ?? true,
      autoStart: n.auto_start ?? true,
      dependsOn: n.depends_on ?? [],
      criteria: n.acceptance_criteria.map((c, i) =>
        crit(`${n.name}-${i + 1}`, c),
      ),
    })),
    finalCriteria: finalCriteria.map((c, i) =>
      crit(`final-${i + 1}`, {
        statement: c.statement,
        measure: c.how_observed,
        deadline: c.deadline,
      }),
    ),
  };
}

/** Inverse, for a plan whose ids are slugs (a template or a plan from planFromWire). */
export function planToWire(plan: PlanDraft): {
  stage_plan: WireStageNode[];
  final_acceptance_criteria: WireFinalCriterion[];
} {
  return {
    stage_plan: plan.stages.map((s) => ({
      name: s.id,
      label: s.name,
      goal: s.goal,
      acceptance_criteria: s.criteria.map((c) => ({
        statement: c.statement,
        measure: c.measure,
        ...(c.target !== undefined && { target: c.target }),
        ...(c.evidenceHint !== undefined && { evidence_hint: c.evidenceHint }),
        ...(c.deadline !== undefined && { deadline: c.deadline }),
      })),
      decision_method: s.decisionMethod,
      depends_on: s.dependsOn,
      required: s.required,
      needs_choice: s.needsChoice,
      auto_start: s.autoStart,
    })),
    final_acceptance_criteria: plan.finalCriteria.map((c) => ({
      statement: c.statement,
      how_observed: c.measure,
      ...(c.deadline !== undefined && { deadline: c.deadline }),
    })),
  };
}

// ---- per-stage records ----
export interface WireOption {
  stage_ref: string;
  option_statement: string;
  mechanism: string;
  responsible_role: string;
  authority_and_legal_basis: string;
  cost_estimate: { band: string; amount?: number };
  how_it_meets_stage_criteria: { criterion_ref: number; how: string }[];
  risks_and_rights_impact: string;
  lawful_alternatives: string[];
  assumptions: string[];
}
export interface WireChoice {
  stage_ref: string;
  decision_method: DecisionMethod;
  chosen_option_ids?: string[];
  steps?: { step: string; owner_role: string; done_criterion: string }[];
  decider_role: string;
  authority: string;
  rationale: string;
  dissent_notes?: string[];
  legal_gate_record: { layer: string; result: string };
}
export interface WireEvidence {
  stage_ref: string;
  criterion_ref: number;
  evidence_refs: { url: string; description: string; tier_request?: string }[];
}
