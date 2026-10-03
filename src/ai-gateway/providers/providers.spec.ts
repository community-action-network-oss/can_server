import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { afterAll, describe, expect, it } from 'vitest';
import { screenOutput } from '../app/output-gate.js';
import { detectSpans } from '../app/redaction/detectors.js';
import { buildPrompt } from '../app/prompt-builder.js';
import type { GatewayOutput, ModelProvider } from '../domain/types.js';
import { costMicroUsd } from './cost.js';
import { ProviderError } from './errors.js';
import {
  FakeModel,
  type FakeScript,
  type KeywordTable,
} from './fake/fake-model.js';
import { RecordingProvider, ReplayProvider } from './replay/replay.js';
import { selectProvider } from './select.js';

const FX = 'test/fixtures/moderation/fake';
const table = (n: number) =>
  JSON.parse(
    readFileSync(`${FX}/keywords-fake-${n}.json`, 'utf8'),
  ) as KeywordTable;
const schema = JSON.parse(
  readFileSync(
    'test/fixtures/policy-v1/base@1.0.0/decision-points/DP-NAMING/schema.json',
    'utf8',
  ),
);
const validate = new Ajv({ strict: true }).compile(schema);

const TEMPLATE = `## RULES
{{RULES}}
<<<DATA field=x
(the labelled lines are inserted here by the server)
DATA>>>
`;
const req = (
  text = 'The ward clerk office handles this',
  stage = 'dp-naming',
  maxOut = 600,
): GatewayOutput =>
  buildPrompt(
    {
      kind: 'moderation',
      stage,
      dpId: 'DP-NAMING',
      template: TEMPLATE,
      ruleSlice: 'NAMING-1: no private names',
      fields: [{ fieldRef: 'description', text }],
      schema,
      metadata: { jurisdiction: 'j' },
    },
    {
      random: { hex: (n) => 'ab'.repeat(n).slice(0, n * 2) },
      maxInputTokens: 6000,
      maxOutputTokens: maxOut,
    },
  ).out;
const scripted = (s: FakeScript) =>
  new FakeModel('fake-1', table(1), { script: () => s });
const dirs: string[] = [];
const tmp = () => (
  dirs.push(mkdtempSync(join(tmpdir(), 'rec-'))),
  dirs.at(-1)!
);
afterAll(() =>
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true })),
);

describe('FakeModel', () => {
  it('is deterministic: same request, same bytes', async () => {
    const m = new FakeModel('fake-1', table(1));
    const a = JSON.stringify(await m.complete(req()));
    expect(JSON.stringify(await m.complete(req()))).toBe(a);
    const r = JSON.parse(a);
    expect(r.json).toMatchObject({
      outcome: 'publish',
      confidence: 0.88,
      rule_ids: ['NAMING-1'],
    });
    expect(validate(r.json)).toBe(true);
  });
  it('fake-2 uses its own table', async () => {
    const r = await new FakeModel('fake-2', table(2)).complete(req());
    expect(r.json).toMatchObject({
      outcome: 'needs_revision',
      confidence: 0.7,
    });
    expect(r.modelId).toBe('fake-2');
  });
  it('classify and explain stages', async () => {
    const m = new FakeModel('fake-1', table(1));
    const c = (await m.complete(req('burn it down', 'classify')))
      .json as Record<string, unknown>;
    expect(c).toMatchObject({ language: 'en', risk_tier: 'high' });
    const e = (await m.complete(req('x', 'explain'))).json as {
      explanation: string;
    };
    expect(e.explanation).toContain('NAMING-1');
  });
  it('token counts are a fixed ratio and cost is exact', async () => {
    const q = req();
    const r = await new FakeModel('fake-1', table(1)).complete(q);
    expect(r.tokensIn).toBe(
      Math.ceil(q.system.length / 4) + Math.ceil(q.data.length / 4),
    );
    expect(costMicroUsd(1000, 0.5)).toBe(500);
  });

  const run = (s: FakeScript) => scripted(s).complete(req());
  it('timeout, refusal and over_budget throw typed errors', async () => {
    await expect(run('timeout')).rejects.toMatchObject({ code: 'timeout' });
    await expect(run('refusal')).rejects.toMatchObject({ code: 'refusal' });
    await expect(run('over_budget')).rejects.toMatchObject({
      code: 'over_budget',
    });
    await expect(
      new FakeModel('fake-1', table(1)).complete(req('x', 'dp-naming', 1)),
    ).rejects.toBeInstanceOf(ProviderError);
  });
  it('malformed, schema-invalid and extra-key outputs fail the schema (fail closed)', async () => {
    const m = (await run('malformed_json')).json;
    expect(typeof m).toBe('string');
    expect(() => JSON.parse(m as string)).toThrow();
    expect(validate((await run('schema_invalid')).json)).toBe(false);
    expect(validate((await run('extra_keys')).json)).toBe(false);
  });
  it('low confidence stays below any floor', async () => {
    expect(
      ((await run('low_confidence')).json as { confidence: number }).confidence,
    ).toBeLessThan(0.1);
  });
  it('canary echo and unknown rule id are caught by the output gate', async () => {
    const q = req();
    const gate = (j: unknown) =>
      screenOutput({
        text:
          JSON.stringify(
            (j as { rule_ids?: string[]; reasons?: string[] }).rule_ids ?? j,
          ) + JSON.stringify((j as { reasons?: string[] }).reasons ?? []),
        allowedRuleIds: ['NAMING-1'],
        inputTokens: [],
        restrictedSpans: [],
        canary: q.canary,
      });
    expect(
      gate((await scripted('canary_echo').complete(q)).json),
    ).toMatchObject({ ok: false, code: 'canary' });
    expect(
      gate((await scripted('unknown_rule').complete(q)).json),
    ).toMatchObject({ ok: false, code: 'unknown_rule' });
  });
  it('injection-style output is flagged by its own shape, never trusted: reasons ask to publish', async () => {
    const j = (await run('injection_output')).json as { reasons: string[] };
    expect(j.reasons[0]).toMatch(/ignore .* publish/i);
  });
  it('scripts are refused outside NODE_ENV=test', () => {
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => scripted('timeout')).toThrow(/test-only/);
    } finally {
      process.env.NODE_ENV = was;
    }
  });
});

describe('record and replay', () => {
  it('replays a recording byte-for-byte, and a miss throws without calling out', async () => {
    const dir = tmp();
    const calls: number[] = [];
    const inner: ModelProvider = {
      id: 'fake-1',
      complete: (r) => (
        calls.push(1),
        new FakeModel('fake-1', table(1)).complete(r)
      ),
    };
    const rec = await new RecordingProvider(inner, dir, true).complete(req());
    const rp = new ReplayProvider('fake-1', dir);
    expect(await rp.complete(req())).toEqual(rec);
    expect(calls).toHaveLength(1);
    await expect(
      rp.complete(req('something never recorded')),
    ).rejects.toMatchObject({ code: 'missing_recording' });
    expect(readdirSync(dir)).toHaveLength(1);
    // dpId scopes the key
    await expect(
      new ReplayProvider('fake-1', dir, 'DP-OTHER').complete(req()),
    ).rejects.toMatchObject({ code: 'missing_recording' });
  });
  it('does not record unless enabled', async () => {
    const dir = tmp();
    await new RecordingProvider(
      new FakeModel('fake-1', table(1)),
      dir,
      false,
    ).complete(req());
    expect(readdirSync(dir)).toHaveLength(0);
  });
  it('recordings hold no prompt text, data or canary', async () => {
    const dir = tmp();
    const q = req('The ward clerk office handles this');
    await new RecordingProvider(
      new FakeModel('fake-1', table(1)),
      dir,
      true,
    ).complete(q);
    const body = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('');
    expect(body).not.toContain('handles this');
    expect(body).not.toContain(q.canary);
  });
  it('replay folder has no network imports', () => {
    for (const f of readdirSync('src/ai-gateway/providers/replay').filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'),
    ))
      expect(
        readFileSync(`src/ai-gateway/providers/replay/${f}`, 'utf8'),
      ).not.toMatch(
        /node:(?:https?|net|tls|dns|http2)|\bfetch\(|from ['"](?:https?|axios|undici)/,
      );
  });
});

describe('selectProvider', () => {
  it('fake only under test or explicit; nothing by default in production', () => {
    const t = `${FX}/keywords-fake-1.json`;
    expect(selectProvider({ NODE_ENV: 'test', AI_FAKE_TABLE: t }).id).toBe(
      'fake-1',
    );
    expect(
      selectProvider({
        NODE_ENV: 'production',
        AI_PROVIDER: 'fake',
        AI_FAKE_TABLE: t,
      }).id,
    ).toBe('fake-1');
    for (const e of [
      { NODE_ENV: 'production' },
      {},
      { AI_PROVIDER: 'openrouter' },
      { AI_PROVIDER: 'anthropic' },
    ])
      expect(() => selectProvider(e)).toThrow(ProviderError);
    expect(
      selectProvider({ AI_PROVIDER: 'replay', AI_REPLAY_DIR: '/x' }),
    ).toBeInstanceOf(ReplayProvider);
  });
});

describe('fixtures', () => {
  it('contain no personal data', () => {
    for (const f of readdirSync(FX))
      expect(detectSpans(readFileSync(join(FX, f), 'utf8')), f).toEqual([]);
  });
});
