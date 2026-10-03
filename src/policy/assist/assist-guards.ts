import { screenOutput } from '../../ai-gateway/app/output-gate.js';

export interface AssistSuggestion {
  field_ref: string;
  value: string;
  basis: string;
  confidence: number;
}
export interface AssistQuestion {
  field_ref: string;
  text: string;
}
export interface ShapeCtx {
  /** Schema fields the poster may be helped with (no_assist and non-text fields already removed). */
  allowed: ReadonlySet<string>;
  /** The poster's original notes: the only source an invented URL, number or date is checked against. */
  notes: string;
  /** Tokens issued for this call and the originals they replaced. */
  tokens: readonly string[];
  originals: readonly string[];
  /** Suggestions below this are dropped; questions stay. */
  floor: number;
}
export interface Shaped {
  suggestions: AssistSuggestion[];
  questions: AssistQuestion[];
  dropped: number;
}

const norm = (s: string) =>
  s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
const URL_RE = /(?:https?:\/\/|www\.)[^\s"')\]>]+/gi;
const NUM_RE = /\d[\d.,]*\d|\d/g;
const MONTH =
  /\b(?:January|February|March|April|June|July|August|September|October|November|December)\b|\bMay\b/gi;
// Server-line and delimiter shapes a model must never write back (forged server lines).
const FORGED =
  /<<<DATA|DATA>>>|\blegal_(?:l[1-6]|stack|gate)\b|\bdiff_(?:rule|article)\b|\(the labelled lines/i;
const trimEnd = (u: string) => u.replace(/[.,;:!?]+$/, '');

/** True when every URL, number and month in `value` also occurs in the notes. */
export function grounded(value: string, notes: string): boolean {
  const n = norm(notes);
  const has = (x: string) => n.includes(norm(x));
  return (
    (value.match(URL_RE) ?? []).every((u) => has(trimEnd(u))) &&
    (value.match(NUM_RE) ?? []).every((x) => has(x.replace(/[.,]+$/, ''))) &&
    (value.match(MONTH) ?? []).every(has)
  );
}

/**
 * Hard rules in code, never trusted to the model: unknown or no_assist fields, one per field, invented
 * URLs/numbers/dates, a basis that is not a quote from the notes, forged server lines, and the output gate.
 */
export function shapeAssist(
  raw: {
    confidence: number;
    suggestions?: {
      field_ref: { field: string };
      value: string;
      basis: string;
    }[];
    questions?: { field_ref: { field: string }; text: string }[];
  },
  c: ShapeCtx,
): Shaped {
  const urls = c.notes.match(URL_RE)?.map(trimEnd) ?? [];
  const clean = (t: string) =>
    !FORGED.test(t) &&
    screenOutput({
      text: t,
      allowedRuleIds: [],
      inputTokens: c.tokens,
      inputOriginals: c.originals,
      restrictedSpans: [],
      allowedUrls: urls,
    }).ok;
  const n = norm(c.notes);
  const taken = new Set<string>();
  let dropped = 0;
  const suggestions: AssistSuggestion[] = [];
  for (const s of c.floor <= raw.confidence ? (raw.suggestions ?? []) : []) {
    const f = s.field_ref.field;
    const b = norm(s.basis).trim();
    if (
      !c.allowed.has(f) ||
      taken.has(f) ||
      b.length < 3 ||
      !n.includes(b) ||
      !grounded(s.value, c.notes) ||
      !clean(s.value) ||
      FORGED.test(s.basis) ||
      c.originals.some((o) => o.trim() && b.includes(norm(o)))
    ) {
      dropped++;
      continue;
    }
    taken.add(f);
    suggestions.push({
      field_ref: f,
      value: s.value,
      basis: s.basis,
      confidence: raw.confidence,
    });
  }
  const questions: AssistQuestion[] = [];
  for (const q of raw.questions ?? []) {
    const f = q.field_ref.field;
    if (!c.allowed.has(f) || taken.has(f) || !clean(q.text)) {
      dropped++;
      continue;
    }
    taken.add(f);
    questions.push({ field_ref: f, text: q.text });
  }
  return { suggestions, questions, dropped };
}
