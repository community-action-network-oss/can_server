import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildPrompt } from '../../app/prompt-builder.js';
import {
  DEFAULT_REGISTER,
  type ModelEntry,
} from '../../register/model-register.js';
import { ProviderError } from '../errors.js';
import { selectProvider } from '../select.js';
import { OPENROUTER_URL, OpenRouterProvider } from './openrouter.js';

const KEY = 'sk-or-test-SECRET-123';
const schema = JSON.parse(
  readFileSync(
    'test/fixtures/policy-v1/base@1.0.0/decision-points/DP-NAMING/schema.json',
    'utf8',
  ),
);
const entry: ModelEntry = {
  ...DEFAULT_REGISTER[0],
  id: 'openrouter:vendor/model:free',
  provider: 'openrouter',
  evalExpiry: '2999-01-01',
};
const req = () =>
  buildPrompt(
    {
      kind: 'moderation',
      stage: 'dp-naming',
      dpId: 'DP-NAMING',
      template:
        '{{RULES}}\n<<<DATA field=x\n(the labelled lines are inserted here by the server)\nDATA>>>\n',
      ruleSlice: 'NAMING-1: no private names',
      fields: [{ fieldRef: 'description', text: 'The ward office' }],
      schema,
      metadata: { jurisdiction: 'j' },
    },
    {
      random: { hex: (n) => 'ab'.repeat(n).slice(0, n * 2) },
      maxInputTokens: 6000,
      maxOutputTokens: 600,
    },
  ).out;
const good = {
  outcome: 'publish',
  confidence: 0.9,
  rule_ids: ['NAMING-1'],
  reasons: ['ok'],
};
const reply = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });
const ok = (content: unknown = JSON.stringify(good), extra = {}) =>
  reply({
    choices: [{ message: { content }, finish_reason: 'stop', ...extra }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  });
const make = (
  f: () => Promise<Response>,
  o: Partial<ConstructorParameters<typeof OpenRouterProvider>[0]> = {},
) => {
  const fetchMock = vi.fn(f);
  return {
    fetchMock,
    p: new OpenRouterProvider({
      entry,
      apiKey: KEY,
      spendCapMonthlyUsd: 10,
      dataCollection: 'deny',
      fetch: fetchMock as unknown as typeof fetch,
      ...o,
    }),
  };
};

describe('OpenRouterProvider', () => {
  it('sends one routed, tool-free request and returns the parsed result', async () => {
    const q = req();
    const { p, fetchMock } = make(async () => ok());
    const r = await p.complete(q);
    expect(r).toEqual({
      json: good,
      tokensIn: 10,
      tokensOut: 20,
      modelId: entry.id,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(OPENROUTER_URL);
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${KEY}`,
    );
    const b = JSON.parse(init.body as string);
    expect(b.model).toBe('vendor/model:free');
    expect(b.tools).toBeUndefined();
    expect(b.tool_choice).toBeUndefined();
    expect(b.max_tokens).toBe(600);
    expect(b.provider).toEqual({
      data_collection: 'deny',
      allow_fallbacks: false,
      require_parameters: true,
    });
    expect(b.response_format.json_schema.schema).toEqual(schema);
    expect(b.messages[0].content).toContain(q.canary);
    expect(b.messages[1].content).toBe(q.data);
  });

  it('data_collection is allow only for synthetic runs with the env allowing it', async () => {
    const sent = async (o: Parameters<typeof make>[1]) => {
      const { p, fetchMock } = make(async () => ok(), o);
      await p.complete(req());
      return JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      ).provider.data_collection;
    };
    expect(await sent({ dataCollection: 'allow' })).toBe('deny');
    expect(await sent({ dataCollection: 'allow', synthetic: true })).toBe(
      'allow',
    );
    expect(await sent({ synthetic: true })).toBe('deny');
  });

  it('refuses a non-synthetic payload to a data-collecting entry, before any call', async () => {
    const { p, fetchMock } = make(async () => ok(), {
      entry: { ...entry, dataCollection: 'allow' },
    });
    await expect(p.complete(req())).rejects.toMatchObject({
      code: 'endpoint_not_allowed',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cannot be constructed without key, cap, openrouter entry or a current eval', () => {
    const base = {
      entry,
      apiKey: KEY,
      spendCapMonthlyUsd: 10,
      dataCollection: 'deny' as const,
    };
    for (const bad of [
      { apiKey: undefined },
      { apiKey: '' },
      { spendCapMonthlyUsd: 0 },
      { spendCapMonthlyUsd: NaN },
      { entry: { ...entry, provider: 'fake' as const } },
      { entry: { ...entry, evalExpiry: '2000-01-01' } },
      { entry: { ...entry, evalExpiry: null } },
    ])
      expect(() => new OpenRouterProvider({ ...base, ...bad })).toThrow(
        ProviderError,
      );
  });

  it.each([
    ['402', () => new Response('x', { status: 402 }), 'provider_budget'],
    [
      '429',
      () => new Response('x', { status: 429, headers: { 'retry-after': '7' } }),
      'provider_unavailable',
    ],
    ['503', () => new Response('x', { status: 503 }), 'provider_unavailable'],
    ['401', () => new Response('x', { status: 401 }), 'provider_unavailable'],
    [
      'refusal',
      () =>
        ok('', {}) &&
        reply({ choices: [{ message: { refusal: 'no' } }], usage: {} }),
      'refusal',
    ],
    ['filter', () => ok('{}', { finish_reason: 'content_filter' }), 'refusal'],
    ['not json body', () => new Response('<html>'), 'schema_invalid'],
    ['bad content', () => ok('not json'), 'schema_invalid'],
    [
      'schema-invalid',
      () => ok(JSON.stringify({ outcome: 'x' })),
      'schema_invalid',
    ],
    [
      'over output cap',
      () =>
        reply({
          choices: [{ message: { content: '{}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 601 },
        }),
      'over_budget',
    ],
    [
      'truncated',
      () => ok(JSON.stringify(good), { finish_reason: 'length' }),
      'over_budget',
    ],
  ])('maps %s to %s', async (_n, f, code) => {
    const { p } = make(async () => f());
    await expect(p.complete(req())).rejects.toMatchObject({ code });
  });

  it('carries retryAfter on 429', async () => {
    const { p } = make(
      async () =>
        new Response('', { status: 429, headers: { 'retry-after': '7' } }),
    );
    await expect(p.complete(req())).rejects.toMatchObject({ retryAfter: 7 });
  });

  it('maps timeout and network errors, never looping', async () => {
    const t = make(async () => {
      throw Object.assign(new Error('x'), { name: 'TimeoutError' });
    });
    await expect(t.p.complete(req())).rejects.toMatchObject({
      code: 'timeout',
    });
    const n = make(async () => {
      throw new Error(`boom ${KEY} Authorization: Bearer ${KEY}`);
    });
    await expect(n.p.complete(req())).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    expect(n.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('no error, log line or prompt text carries the key', async () => {
    const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map(
      (m) => vi.spyOn(console, m),
    );
    const msgs: string[] = [];
    for (const f of [
      async () => {
        throw new Error(`boom ${KEY}`);
      },
      async () => new Response(`echo ${KEY}`, { status: 500 }),
      async () => ok('not json'),
    ]) {
      try {
        await make(f).p.complete(req());
      } catch (e) {
        msgs.push(String((e as Error).message), String((e as Error).stack));
      }
    }
    const all =
      msgs.join('\n') +
      spies
        .flatMap((s) => s.mock.calls)
        .flat()
        .join('\n');
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('Bearer');
    expect(all).not.toContain('The ward office');
    spies.forEach((s) => s.mockRestore());
  });
});

describe('selectProvider with openrouter', () => {
  it('stays not_selectable without explicit config, even in production', () => {
    for (const env of [
      { NODE_ENV: 'production' },
      { NODE_ENV: 'production', OPEN_ROUTER_KEY: KEY },
      { NODE_ENV: 'production', AI_PROVIDER: 'openrouter' },
      { AI_PROVIDER: 'openrouter', AI_SPEND_CAP_MONTHLY_USD: '10' },
    ])
      expect(() => selectProvider(env, 'x', { entry })).toThrow(
        expect.objectContaining({ code: 'not_selectable' }),
      );
    expect(() =>
      selectProvider({
        AI_PROVIDER: 'openrouter',
        OPEN_ROUTER_KEY: KEY,
        AI_SPEND_CAP_MONTHLY_USD: '10',
      }),
    ).toThrow(ProviderError);
  });
  it('builds when explicitly configured', () => {
    const p = selectProvider(
      {
        NODE_ENV: 'production',
        AI_PROVIDER: 'openrouter',
        OPEN_ROUTER_KEY: KEY,
        AI_SPEND_CAP_MONTHLY_USD: '10',
      },
      entry.id,
      { entry, fetch: (async () => ok()) as unknown as typeof fetch },
    );
    expect(p).toBeInstanceOf(OpenRouterProvider);
  });
});
