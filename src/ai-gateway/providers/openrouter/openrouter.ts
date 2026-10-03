import { Ajv2020 } from 'ajv/dist/2020.js';
import type {
  GatewayOutput,
  ModelProvider,
  ProviderResult,
} from '../../domain/types.js';
import type { ModelEntry } from '../../register/model-register.js';
import { ProviderError } from '../errors.js';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenRouterOptions {
  entry: ModelEntry;
  apiKey: string | undefined;
  spendCapMonthlyUsd: number;
  /** AI_DATA_COLLECTION. `allow` only ever takes effect for synthetic runs. */
  dataCollection: 'deny' | 'allow';
  /** Simulation, seeds, evals, record runs: never real member data. */
  synthetic?: boolean;
  /** Injected in tests; never a real network call there. */
  fetch?: typeof fetch;
  now?: () => Date;
}

const fail = (code: ProviderError['code'], detail?: string, retry?: number) =>
  new ProviderError(code, detail, retry);

/** Plain-fetch OpenAI-compatible adapter. No tools, no retries, no fallback (router owns those). */
export class OpenRouterProvider implements ModelProvider {
  readonly id: string;
  private readonly key: string;
  private readonly slug: string;

  constructor(private readonly o: OpenRouterOptions) {
    const e = o.entry;
    if (e.provider !== 'openrouter')
      throw fail('not_selectable', 'entry is not an openrouter model');
    if (!o.apiKey) throw fail('not_selectable', 'OPEN_ROUTER_KEY is required');
    if (!(o.spendCapMonthlyUsd > 0))
      throw fail('not_selectable', 'AI_SPEND_CAP_MONTHLY_USD must be positive');
    if (
      !e.evalExpiry ||
      Date.parse(e.evalExpiry) <= (o.now?.() ?? new Date()).getTime()
    )
      throw fail('not_selectable', 'no current eval for the register entry');
    this.id = e.id;
    this.key = o.apiKey;
    this.slug = e.id.replace(/^openrouter:/, '');
  }

  async complete(req: GatewayOutput): Promise<ProviderResult> {
    const { entry, synthetic } = this.o;
    if (entry.dataCollection === 'allow' && !synthetic)
      throw fail('endpoint_not_allowed', 'entry collects data');
    const allow = synthetic && this.o.dataCollection === 'allow';
    const body = JSON.stringify({
      model: this.slug,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.data },
      ],
      max_tokens: req.maxOutputTokens,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'stage_output', strict: true, schema: req.schema },
      },
      provider: {
        data_collection: allow ? 'allow' : 'deny',
        allow_fallbacks: false,
        require_parameters: true,
      },
    });

    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.key}`,
          'content-type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(req.timeoutMs),
      });
    } catch (e) {
      // Never forward e.message: runtime errors can echo request details.
      const n = (e as Error | undefined)?.name;
      throw n === 'TimeoutError' || n === 'AbortError'
        ? fail('timeout')
        : fail('provider_unavailable', 'network');
    }
    if (res.status === 402) throw fail('provider_budget', '402');
    if (!res.ok) {
      const ra = Number(res.headers.get('retry-after'));
      throw fail(
        'provider_unavailable',
        String(res.status),
        Number.isFinite(ra) && ra >= 0 ? ra : undefined,
      );
    }

    let j: {
      choices?: {
        message?: { content?: unknown; refusal?: unknown };
        finish_reason?: string;
      }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    try {
      j = await res.json();
    } catch {
      throw fail('schema_invalid', 'response is not json');
    }
    const c = j?.choices?.[0];
    if (c?.message?.refusal || c?.finish_reason === 'content_filter')
      throw fail('refusal');
    const tokensIn = j?.usage?.prompt_tokens;
    const tokensOut = j?.usage?.completion_tokens;
    if (!Number.isInteger(tokensIn) || !Number.isInteger(tokensOut))
      throw fail('schema_invalid', 'no usage');
    if (
      (tokensOut as number) > req.maxOutputTokens ||
      (tokensIn as number) > entry.maxInput ||
      c?.finish_reason === 'length'
    )
      throw fail('over_budget');
    const content = c?.message?.content;
    let json: unknown;
    try {
      json = JSON.parse(content as string);
      if (!new Ajv2020({ strict: true }).validate(req.schema, json))
        throw new Error();
    } catch {
      throw fail('schema_invalid', 'output');
    }
    return {
      json,
      tokensIn: tokensIn as number,
      tokensOut: tokensOut as number,
      modelId: this.id,
    };
  }
}
