import type { RetrieveOutcome } from '../../policy/legal/retrieval/retrieve.js';

/** Per-run random source, injected so tests are deterministic. */
export interface Random {
  /** Lowercase hex of `bytes` random bytes. */
  hex(bytes: number): string;
}

/** One user field, already redacted by the privacy gateway. `fieldRef` is a label such as `description` or `authenticity_note s2`. */
export interface GatewayField {
  fieldRef: string;
  text: string;
}

/** A server-inserted labelled line (never user text). */
export interface ServerLine {
  label: string;
  value: string;
}

export interface GatewayInput {
  /** `assist` is the non-moderation ASSIST-FILL task (10-u30); it uses the same redaction, budgets and providers. */
  kind: 'moderation' | 'assist';
  stage: string;
  /** null for assist. */
  dpId: string | null;
  /** The DP prompt.md from the pack, with {{RULES}} and {{SHOTS}} placeholders and one DATA block. */
  template: string;
  /** Resolved rule slice for {{RULES}} (pack text, public). */
  ruleSlice: string;
  /** Worked examples for {{SHOTS}} (pack text, public). */
  shots?: string;
  /** Quoted user fields, one line each. */
  fields: readonly GatewayField[];
  /** Server labelled lines other than legal_*: once-only labels once, `legal_gate`/`diff_rule`/`diff_article`/`source` one per item. */
  serverLines?: readonly ServerLine[];
  /** Result of tryRetrieveLegal. Required when the template reads legal_L lines; a failure holds the run. */
  legal?: RetrieveOutcome;
  /** Output contract the provider must satisfy (schema.json). */
  schema: object;
  metadata: { jurisdiction: string; policyVersion?: string; language?: string };
  timeoutMs?: number;
}

declare const GATEWAY_OUTPUT: unique symbol;

export interface GatewayOutputFields {
  readonly stage: string;
  /** sha256 of the rendered template before data insertion. */
  readonly promptHash: string;
  /** Pack text, rule slice, output contract and the per-run canary. Public. */
  readonly system: string;
  /** The quoted, redacted data block. */
  readonly data: string;
  /** The per-run canary token; a run whose output contains it is held. */
  readonly canary: string;
  readonly schema: object;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

/**
 * The only thing `ModelProvider.complete()` accepts. Built solely by `mintGatewayOutput`
 * (domain/gateway-output.ts), which only the prompt builder calls (architecture test).
 */
export type GatewayOutput = GatewayOutputFields & {
  readonly [GATEWAY_OUTPUT]: true;
};

export interface ProviderResult {
  json: unknown;
  tokensIn: number;
  tokensOut: number;
  modelId: string;
}

export interface ModelProvider {
  /** Register entry, e.g. "fake-1", "openrouter:<model-slug>". */
  id: string;
  complete(req: GatewayOutput): Promise<ProviderResult>;
}

/** What a stage run yields. The raw prompt and data are never part of it (hash only). */
export interface StageResult {
  json: unknown;
  promptHash: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
}

export interface AiGatewayPort {
  /** Throws GatewayError; callers translate any failure into `hold`. */
  run(input: GatewayInput): Promise<StageResult>;
}

export const AI_GATEWAY = Symbol('AI_GATEWAY_PORT');
