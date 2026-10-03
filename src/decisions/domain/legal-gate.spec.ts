import { describe, expect, it } from 'vitest';
import {
  choiceGateValue,
  decideGate,
  GATE_LAYERS,
  type GateFinding,
} from './legal-gate.js';

const base = (over: Record<string, Partial<GateFinding>> = {}): GateFinding[] =>
  GATE_LAYERS.map((layer) => ({
    layer,
    finding: 'none_found' as const,
    corpus_version: `c-${layer}@0.1.0+abc123abc123`,
    article_ids: [],
    blocks: false,
    ...over[layer],
  }));
const block = {
  finding: 'constrains' as const,
  blocks: true,
  article_ids: ['L3/x/art-1'],
};

describe('decideGate', () => {
  it('clears when every layer has a finding and none blocks', () => {
    expect(
      decideGate(base({ L6: { finding: 'permits', article_ids: ['a'] } }))
        .outcome,
    ).toBe('clear');
    expect(
      decideGate(
        base({ L2: { finding: 'not_applicable', corpus_version: null } }),
      ).outcome,
    ).toBe('clear');
  });
  it('holds on a missing layer, a stray not_applicable and a conflict', () => {
    expect(decideGate(base().slice(0, 5)).outcome).toBe('hold');
    expect(
      decideGate(
        base({ L4: { finding: 'not_applicable', corpus_version: null } }),
      ).outcome,
    ).toBe('hold');
    expect(decideGate(base({ L4: { finding: 'conflict' } })).outcome).toBe(
      'hold',
    );
    expect(decideGate(base({ L1: { corpus_version: null } })).outcome).toBe(
      'hold',
    );
  });
  it('a block stands whatever lower layers permit, and cites layer and article', () => {
    const v = decideGate(
      base({ L3: block, L6: { finding: 'permits', article_ids: ['b'] } }),
    );
    expect(v).toMatchObject({
      outcome: 'blocked',
      sourceRef: 'c-L3@0.1.0+abc123abc123#L3/x/art-1',
    });
    expect(
      decideGate(base({ L3: block, L5: { finding: 'conflict' } })).outcome,
    ).toBe('blocked');
  });
  it('a block without an article holds', () => {
    expect(
      decideGate(base({ L3: { ...block, article_ids: [] } })).outcome,
    ).toBe('hold');
  });
});

describe('choiceGateValue', () => {
  it('maps need and record to the three values', () => {
    expect(choiceGateValue(false, false)).toBe('not_needed');
    expect(choiceGateValue(true, true)).toBe('recorded');
    expect(choiceGateValue(true, false)).toBe('missing');
  });
});
