/** The layered, cited legal-gate record (LEGAL-GATE-1, LEGAL-CITE-1). Pure; article ids only, never article text. */
export const GATE_LAYERS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'] as const;
export type GateLayer = (typeof GATE_LAYERS)[number];
export type LayerFinding =
  'constrains' | 'permits' | 'none_found' | 'conflict' | 'not_applicable';

export interface GateFinding {
  layer: GateLayer;
  finding: LayerFinding;
  /** `<id>@<semver>[+hash12]`; null only for not_applicable. */
  corpus_version: string | null;
  article_ids: string[];
  /** A block stands at its layer: no lower-layer permit relaxes it. */
  blocks: boolean;
}

export type GateVerdict =
  | {
      outcome: 'clear' | 'blocked';
      findings: GateFinding[];
      constraintText: string | null;
      sourceRef: string | null;
    }
  | { outcome: 'hold'; reason: string };

/** Layers where the jurisdiction's pinned legal_stack may declare not_applicable. */
const MAY_BE_NA: readonly GateLayer[] = ['L2', 'L5'];

/** Fail closed: a missing or doubled layer, a stray not_applicable or a conflict holds; a block at any layer stands. */
export function decideGate(findings: readonly GateFinding[]): GateVerdict {
  const byLayer = new Map(findings.map((f) => [f.layer, f]));
  if (
    findings.length !== GATE_LAYERS.length ||
    byLayer.size !== GATE_LAYERS.length
  )
    return { outcome: 'hold', reason: 'a legal layer has no finding' };
  const ordered = GATE_LAYERS.map((l) => byLayer.get(l));
  if (ordered.some((f) => !f))
    return { outcome: 'hold', reason: 'a legal layer has no finding' };
  const all = ordered as GateFinding[];
  for (const f of all) {
    if (f.finding === 'not_applicable' && !MAY_BE_NA.includes(f.layer))
      return { outcome: 'hold', reason: `${f.layer} cannot be not_applicable` };
    if (f.finding !== 'not_applicable' && !f.corpus_version)
      return { outcome: 'hold', reason: `${f.layer} cites no corpus version` };
    if (f.blocks && (f.finding !== 'constrains' || !f.article_ids.length))
      return { outcome: 'hold', reason: `${f.layer} block cites no article` };
  }
  const blocking = all.filter((f) => f.blocks);
  if (blocking.length) {
    const b = blocking[0];
    return {
      outcome: 'blocked',
      findings: all,
      constraintText: `${b.layer} constrains this choice: ${b.article_ids.join(', ')} in ${b.corpus_version}.`,
      sourceRef: `${b.corpus_version}#${b.article_ids[0]}`,
    };
  }
  const c = all.find((f) => f.finding === 'conflict');
  if (c) return { outcome: 'hold', reason: `${c.layer} findings conflict` };
  return {
    outcome: 'clear',
    findings: all,
    constraintText: null,
    sourceRef: null,
  };
}

/** The three-way value DP-STAGE-RESOLUTION reads (`choice_gate`), from a real record only. */
export type ChoiceGateValue = 'not_needed' | 'recorded' | 'missing';
export const choiceGateValue = (
  needsChoice: boolean,
  liveClearRecord: boolean,
): ChoiceGateValue =>
  !needsChoice ? 'not_needed' : liveClearRecord ? 'recorded' : 'missing';
