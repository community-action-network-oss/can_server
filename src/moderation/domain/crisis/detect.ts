import { classifyStatement } from '../../../problems/domain/eligibility/classify.js';
import { normalise } from '../../../problems/domain/privacy/detect.js';
import {
  CRISIS_LEXICON,
  LEGAL_LEXICON,
  type CrisisCategory,
  type CrisisEntry,
  type CrisisLevel,
  type LegalKind,
} from './lexicon.js';

export interface CrisisField {
  ref: string;
  text: string;
}
/** Offsets are into the normalised text of the field; no text is carried. */
export interface CrisisSpan {
  ref: string;
  start: number;
  end: number;
  category: CrisisCategory;
}
export interface CrisisResult {
  level: CrisisLevel;
  categories: CrisisCategory[];
  spans: CrisisSpan[];
}
export interface LegalResult {
  hit: boolean;
  kinds: LegalKind[];
  fieldRefs: string[];
}

const RANK: Record<CrisisLevel, number> = {
  none: 0,
  possible: 1,
  clear: 2,
  imminent: 3,
};

const CONFUSABLE: Record<string, string> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  і: 'i',
  ѕ: 's',
  ј: 'j',
  к: 'k',
  м: 'm',
  т: 't',
  н: 'h',
  в: 'b',
  α: 'a',
  ε: 'e',
  ο: 'o',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w: string) =>
  w === '*'
    ? '[\\p{L}\\p{N}]+'
    : esc(w.replace(/\*$/, '')) + (w.endsWith('*') ? '[\\p{L}]*' : '');
const phraseRe = (p: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}_])${p.split(' ').map(wordRe).join("[\\s.,'’_-]+")}(?![\\p{L}\\p{N}_])`,
    'u',
  );
// Squashed form: letters only, so "k i l l  m y s e l f" and "k.i.l.l" still match. Long phrases only.
const squash = (p: string) => p.replace(/[^a-z]/g, '');
const prep = (text: string) =>
  normalise(text).text.toLowerCase().replace(/’/g, "'");
const fold = (t: string) => Array.from(t, (c) => CONFUSABLE[c] ?? c).join('');

function compile(phrases: string[]) {
  return phrases.map((p) => ({
    re: phraseRe(p),
    sq: p.split(' ').includes('*') ? '' : squash(p),
  }));
}
const crisisC = CRISIS_LEXICON.map((e) => ({ e, c: compile(e.phrases) }));
const legalC = LEGAL_LEXICON.map((e) => ({ e, c: compile(e.phrases) }));

function matches(
  t: string,
  sq: string,
  c: ReturnType<typeof compile>,
): { start: number; end: number } | null {
  for (const x of c) {
    const m = x.re.exec(t) ?? x.re.exec(fold(t));
    if (m) return { start: m.index, end: m.index + m[0].length };
    if (x.sq.length >= 7 && sq.includes(x.sq))
      return { start: 0, end: t.length };
  }
  return null;
}

/**
 * Pure, model-free. Runs every lexicon whatever `language` says (an unknown language must not mean no crisis).
 * `extra` carries pack terms when present.
 */
export function detectCrisis(
  fields: CrisisField[],
  _language?: string,
  extra: CrisisEntry[] = [],
): CrisisResult {
  const extraC = extra.map((e) => ({ e, c: compile(e.phrases) }));
  let level: CrisisLevel = 'none';
  const cats = new Set<CrisisCategory>();
  const spans: CrisisSpan[] = [];
  const bump = (l: CrisisLevel) => {
    if (RANK[l] > RANK[level]) level = l;
  };
  for (const f of fields) {
    const t = prep(f.text);
    const sq = squash(fold(t));
    for (const { e, c } of [...crisisC, ...extraC]) {
      const m = matches(t, sq, c);
      if (!m) continue;
      bump(e.level);
      cats.add(e.category);
      spans.push({ ref: f.ref, ...m, category: e.category });
    }
    // Reuse the 10-u32 emergency phrase classifier: anything it flags is at least possible.
    const k = classifyStatement(f.text);
    if (!k.ok && k.ineligibilityCode === 'emergency') bump('possible');
  }
  return { level, categories: [...cats], spans };
}

export function detectLegalProcess(fields: CrisisField[]): LegalResult {
  const kinds = new Set<LegalKind>();
  const refs = new Set<string>();
  for (const f of fields) {
    const t = prep(f.text);
    const sq = squash(fold(t));
    for (const { e, c } of legalC) {
      if (matches(t, sq, c)) {
        kinds.add(e.kind);
        refs.add(f.ref);
      }
    }
  }
  return { hit: kinds.size > 0, kinds: [...kinds], fieldRefs: [...refs] };
}
