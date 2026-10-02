import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { explanationFromRules, screenOutput } from './output-gate.js';

const fx = JSON.parse(
  readFileSync('test/fixtures/moderation/output-gate/cases.json', 'utf8'),
) as {
  allowed_rule_ids: string[];
  input_tokens: string[];
  originals: string[];
  restricted: string[];
  canary: string;
  reject: { id: string; text: string; code: string }[];
  accept: string[];
};
const gate = (text: string) =>
  screenOutput({
    text,
    allowedRuleIds: fx.allowed_rule_ids,
    inputTokens: fx.input_tokens,
    inputOriginals: fx.originals,
    restrictedSpans: fx.restricted,
    canary: fx.canary,
  });

describe('screenOutput', () => {
  it.each(fx.reject)('rejects $id with $code', (c) => {
    expect(gate(c.text)).toEqual({ ok: false, code: c.code });
  });
  it.each(fx.accept)('accepts clean output: %s', (t) => {
    expect(gate(t)).toEqual({ ok: true, text: t });
  });
  it('accepts a listed url only', () => {
    const t = 'Source: https://example.org/a.';
    const r = screenOutput({
      text: t,
      allowedRuleIds: [],
      inputTokens: [],
      restrictedSpans: [],
      allowedUrls: ['https://example.org/a'],
    });
    expect(r.ok).toBe(true);
  });
});

describe('explanationFromRules', () => {
  const rules = new Map([
    ['FRAME-1', 'A post should describe a public condition, not a person.'],
    ['COMPLETE-1', 'Every required field needs a real answer.'],
  ]);
  it('is deterministic, passes its own gate and holds only registry text', () => {
    const a = explanationFromRules(
      ['FRAME-1', 'COMPLETE-1'],
      'statement',
      rules,
    );
    expect(a).toEqual(
      explanationFromRules(['FRAME-1', 'COMPLETE-1'], 'statement', rules),
    );
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.text).toContain('FRAME-1: A post should');
  });
  it('never carries a field ref that looks like input text', () => {
    const r = explanationFromRules(['FRAME-1'], 'Marcus Vellan said', rules);
    expect(r.ok && r.text).not.toContain('Marcus');
  });
  it('fails closed on a rule without plain text, or no rules', () => {
    expect(explanationFromRules(['NAME-1'], null, rules).ok).toBe(false);
    expect(explanationFromRules([], null, rules).ok).toBe(false);
  });
  it('fails closed when the registry text itself leaks', () => {
    const bad = new Map([['FRAME-1', 'Ask jo@example.com instead.']]);
    expect(explanationFromRules(['FRAME-1'], null, bad)).toEqual({
      ok: false,
      code: 'pii_leak',
    });
  });
});
