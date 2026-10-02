import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classify } from '../zones.js';
import { PrivacyGatewayError } from './errors.js';
import { expand, redact } from './redact.js';

const dir = 'test/fixtures/moderation/priv-gateway/';
const cases = JSON.parse(readFileSync(dir + 'cases.json', 'utf8')) as {
  positive: {
    id: string;
    script: string;
    fields: { fieldRef: string; text: string }[];
    seeds: string[];
  }[];
  benign: { id: string; fields: { fieldRef: string; text: string }[] }[];
};
const thresholds = JSON.parse(
  readFileSync(dir + 'thresholds.json', 'utf8'),
) as {
  min_recall: number;
  max_over_redaction: number;
};

describe('redact on the priv-gateway fixtures', () => {
  it('removes every seeded identifier (recall) and keeps over-redaction under the threshold', () => {
    let seeds = 0;
    const missed: string[] = [];
    for (const c of cases.positive) {
      let out: string;
      try {
        out = redact(c.fields)
          .fields.map((f) => f.text)
          .join('\n');
      } catch (e) {
        // Fail closed counts as safe: no output exists.
        expect(e).toBeInstanceOf(PrivacyGatewayError);
        seeds += c.seeds.length;
        continue;
      }
      for (const s of c.seeds) {
        seeds++;
        if (out.includes(s)) missed.push(`${c.id}: ${s}`);
      }
    }
    const recall = (seeds - missed.length) / seeds;
    const over = cases.benign
      .filter((c) => redact(c.fields).redactionCount > 0)
      .map((c) => c.id);
    const overRate = over.length / cases.benign.length;
    console.info(
      JSON.stringify({
        redaction_recall: recall,
        over_redaction: overRate,
        missed,
        over,
      }),
    );
    expect(missed).toEqual([]);
    expect(recall).toBeGreaterThanOrEqual(thresholds.min_recall);
    expect(overRate).toBeLessThanOrEqual(thresholds.max_over_redaction);
  });

  it('does not fail closed on fixture positives (they must be redacted, not held)', () => {
    for (const c of cases.positive)
      expect(() => redact(c.fields), c.id).not.toThrow();
  });

  it('gives one token to one value, across fields, and offsets point into the original', () => {
    const f = [
      { fieldRef: 'a', text: 'Email maria@example.org now.' },
      { fieldRef: 'b', text: 'Again MARIA@example.org.' },
    ];
    const r = redact(f);
    expect(r.fields[0]!.text).toBe('Email [EMAIL_1] now.');
    expect(r.fields[1]!.text).toBe('Again [EMAIL_1].');
    expect(r.entries).toHaveLength(1);
    const s = r.fields[0]!.spans[0]!;
    expect(f[0]!.text.slice(s.start, s.end)).toBe('maria@example.org');
    expect(Object.keys(s).sort()).toEqual(['end', 'kind', 'start', 'token']);
  });

  it('expands tokens back', () => {
    const r = redact([{ fieldRef: 'a', text: 'Call 020 7946 0958 soon.' }]);
    const map = new Map(r.entries.map((e) => [e.token, e.original]));
    expect(expand(r.fields[0]!.text, map)).toBe('Call 020 7946 0958 soon.');
  });

  it('fails closed on an unsupported script and on oversize text', () => {
    for (const text of ['这是一个测试', 'x'.repeat(20_001)])
      expect(() => redact([{ fieldRef: 'a', text }])).toThrowError(
        /gateway_failure/,
      );
  });
});

describe('zones', () => {
  it('refuses audit, claimed-sanitized and content-bearing restricted evidence', () => {
    const bad = [
      { zone: 'audit', fieldRef: 'a', text: 'x' },
      { zone: 'sanitized', fieldRef: 'a', text: 'x' },
      {
        zone: 'restricted_evidence',
        fieldRef: 'a',
        tier: 'T1',
        description: 'd',
        text: 'secret content',
      },
      {
        zone: 'restricted_evidence',
        fieldRef: 'a',
        tier: 'T1',
        description: 'd',
        content: 'secret',
      },
      {
        zone: 'restricted_evidence',
        fieldRef: 'a',
        tier: 'bad tier!',
        description: 'd',
      },
    ];
    for (const b of bad)
      expect(() => classify(b as never)).toThrowError(/zone_violation/);
  });
  it('lets evidence through as tier and description only', () => {
    expect(
      classify({
        zone: 'restricted_evidence',
        fieldRef: 'e',
        tier: 'T2',
        description: 'photo of a drain',
      }),
    ).toBe('tier T2: photo of a drain');
  });
});
