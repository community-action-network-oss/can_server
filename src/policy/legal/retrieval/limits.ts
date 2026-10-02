/** Retrieval limits from the active pack's `limits.legal.retrieval`; code defaults only when the pack predates the block. */
export interface LegalRetrievalLimits {
  max_articles_per_layer: number;
  token_budget_per_run: number;
  low_confidence_floor: number;
  risky_topics: readonly string[];
  /** Keys that were absent or malformed in the pack and fell back to the defaults below. */
  defaulted: readonly string[];
}

const DEFAULTS = {
  max_articles_per_layer: 3,
  token_budget_per_run: 2500,
  low_confidence_floor: 0.6,
  risky_topics: [
    'public-order',
    'criminal-procedure',
    'explosives-and-weapons',
    'data-protection-implementation',
  ],
} as const;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;

/** `limits` is the parsed limits.yaml root. Entries are `{value: ...}` in the pack; a bare value is tolerated. */
export function legalRetrievalLimits(limits: unknown): LegalRetrievalLimits {
  const r = obj(obj(obj(limits)?.legal)?.retrieval);
  const defaulted: string[] = [];
  const pick = <T>(k: keyof typeof DEFAULTS, ok: (v: unknown) => v is T): T => {
    const e = r?.[k];
    const v = obj(e) && 'value' in (e as Obj) ? (e as Obj).value : e;
    if (ok(v)) return v;
    defaulted.push(k);
    return DEFAULTS[k] as unknown as T;
  };
  const int = (v: unknown): v is number =>
    Number.isInteger(v) && (v as number) > 0;
  const frac = (v: unknown): v is number =>
    typeof v === 'number' && v >= 0 && v <= 1;
  const strs = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string');
  return {
    max_articles_per_layer: pick('max_articles_per_layer', int),
    token_budget_per_run: pick('token_budget_per_run', int),
    low_confidence_floor: pick('low_confidence_floor', frac),
    risky_topics: pick('risky_topics', strs),
    defaulted,
  };
}
