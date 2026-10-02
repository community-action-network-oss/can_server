import { detectSpans } from './redaction/detectors.js';

/** Server-side cap, same as the 600 char allOf in the can_policy DP schemas. */
export const MAX_OUTPUT_CHARS = 600;

export type OutputGateCode =
  | 'pii_leak'
  | 'secret'
  | 'restricted_quote'
  | 'score_disclosure'
  | 'unknown_rule'
  | 'canary'
  | 'url'
  | 'unresolved_token'
  | 'too_long'
  | 'unscreenable';

export type OutputGateResult =
  { ok: true; text: string } | { ok: false; code: OutputGateCode };

export interface OutputGateInput {
  text: string;
  allowedRuleIds: readonly string[];
  /** Tokens issued for this run, e.g. "[PERSON_1]". Any token-shaped string is rejected anyway. */
  inputTokens: readonly string[];
  /** Text the output must not quote: LegalArticle.text, hidden prompt parts. */
  restrictedSpans: readonly string[];
  /** Originals of the redacted values, when the caller still holds them (poster's own run). Never logged. */
  inputOriginals?: readonly string[];
  /** The run's canary, if known; the `canary-<hex>` shape is always rejected. */
  canary?: string;
  /** Exact URLs that may appear (e.g. a cited source). Default none. */
  allowedUrls?: readonly string[];
}

// Same script rule as redact(): text in a script the detectors do not cover cannot be screened, so it is refused.
const UNSCREENABLE =
  /(?![\p{Script=Latin}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Cyrillic}])\p{L}/u;
const TOKEN = /\[[A-Z]+_\d+\]/;
const CANARY = /canary-[0-9a-f]{6,}/i;
const URL_RE =
  /(?:https?:\/\/|www\.)\S+|(?<![\p{L}\p{N}@.])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:com|org|net|io|gov|uk|co|info|edu|app|dev|me|ly|xyz|ru|cn|in)(?:\/\S*)?(?![\p{L}\p{N}])/giu;
const RULE_ID = /(?<![\p{L}\p{N}-])[A-Z]{2,}(?:-[A-Z0-9]+)+(?![\p{L}\p{N}-])/gu;
// "confidence 0.82", "score: 85%", "threshold of 0.7", "floor is 60", "82% confident".
const SCORE = [
  /\b(?:confidence|score|scores|threshold|thresholds|floor|floors)\b[^.\n]{0,24}?\d/i,
  /\d\s*%?\s*(?:confident|confidence|certain)\b/i,
];
const QUOTE_WORDS = 6;

const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** True when `out` contains a run of QUOTE_WORDS words of `span` (or all of a shorter span). */
function quotes(out: string, span: string): boolean {
  const o = ` ${norm(out)} `;
  const w = norm(span).split(' ').filter(Boolean);
  if (!w.length) return false;
  const n = Math.min(QUOTE_WORDS, w.length);
  for (let i = 0; i + n <= w.length; i++)
    if (o.includes(` ${w.slice(i, i + n).join(' ')} `)) return true;
  return false;
}

/**
 * Re-screens everything a model says to a person. Never repairs: a failure returns a code and the caller
 * regenerates once via `explanationFromRules` or holds the run. Paraphrase of restricted text is not
 * detectable here; the prompt never contains legal text beyond what the server cites by id.
 */
export function screenOutput(i: OutputGateInput): OutputGateResult {
  const { text } = i;
  const fail = (code: OutputGateCode): OutputGateResult => ({
    ok: false,
    code,
  });
  if (!text.trim() || UNSCREENABLE.test(text)) return fail('unscreenable');
  if (text.length > MAX_OUTPUT_CHARS) return fail('too_long');
  if (CANARY.test(text) || (i.canary && text.includes(i.canary)))
    return fail('canary');
  let spans;
  try {
    spans = detectSpans(text);
  } catch {
    return fail('unscreenable');
  }
  if (spans.some((s) => s.kind === 'SECRET')) return fail('secret');
  if (TOKEN.test(text) || i.inputTokens.some((t) => text.includes(t)))
    return fail('unresolved_token');
  if (spans.length) return fail('pii_leak');
  const low = text.toLowerCase();
  if (
    i.inputOriginals?.some(
      (o) => o.trim().length >= 3 && low.includes(o.toLowerCase()),
    )
  )
    return fail('pii_leak');
  const allowedUrls = new Set(
    (i.allowedUrls ?? []).map((u) => u.toLowerCase()),
  );
  for (const m of text.matchAll(URL_RE))
    if (!allowedUrls.has(m[0].toLowerCase().replace(/[.,;:)]+$/, '')))
      return fail('url');
  if (i.restrictedSpans.some((r) => quotes(text, r)))
    return fail('restricted_quote');
  if (SCORE.some((r) => r.test(text))) return fail('score_disclosure');
  const allowed = new Set(i.allowedRuleIds);
  for (const m of text.matchAll(RULE_ID))
    if (!allowed.has(m[0])) return fail('unknown_rule');
  return { ok: true, text };
}

const SAFE_REF = /^[a-z][a-z0-9_.]{0,63}$/;

/**
 * Deterministic fallback after a failed gate. Built only from rule ids and the registry's plain text for them
 * (`ruleText`, from DpRegistry), plus the field name if it is a plain schema path: no input text can reach it.
 * It is screened like any other text; a rule without plain text, or any failure, returns not ok and the run holds.
 */
export function explanationFromRules(
  ruleIds: readonly string[],
  fieldRef: string | null,
  ruleText: ReadonlyMap<string, string>,
): OutputGateResult {
  if (!ruleIds.length) return { ok: false, code: 'unknown_rule' };
  const lines: string[] = [];
  for (const id of ruleIds) {
    const t = ruleText.get(id);
    if (!t) return { ok: false, code: 'unknown_rule' };
    lines.push(`${id}: ${t.trim()}`);
  }
  const where =
    fieldRef && SAFE_REF.test(fieldRef)
      ? ` Please check the ${fieldRef} field.`
      : '';
  return screenOutput({
    text: `This could not be published as written. ${lines.join(' ')}${where}`,
    allowedRuleIds: ruleIds,
    inputTokens: [],
    restrictedSpans: [],
  });
}
