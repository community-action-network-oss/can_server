import { INSTITUTION_WORDS, LEADING_STOPWORDS, STREET_SUFFIXES } from './allowlist.js';

export type FlagKind =
  | 'person_name'
  | 'phone'
  | 'email'
  | 'government_id'
  | 'street_address'
  | 'vehicle_plate'
  | 'first_person_about_named';

export type PrivacyRuleId = 'PRIV-GATE-1' | 'NAME-1';

export interface Flag {
  kind: FlagKind;
  ruleId: PrivacyRuleId;
  /** Offsets into the ORIGINAL text, end exclusive. */
  start: number;
  end: number;
  suggestion?: string;
}

const GENERIC_SUGGESTION = 'Describe the role or institution instead of the person';

// Rule ids only; rule text lives in can_policy packs and docs/spec/constitution/rules.md.
const RULE_FOR_KIND: Record<FlagKind, PrivacyRuleId> = {
  person_name: 'NAME-1',
  first_person_about_named: 'NAME-1',
  phone: 'PRIV-GATE-1',
  email: 'PRIV-GATE-1',
  government_id: 'PRIV-GATE-1',
  street_address: 'PRIV-GATE-1',
  vehicle_plate: 'PRIV-GATE-1',
};

interface Normalised {
  text: string;
  /** For each UTF-16 unit of `text`, the [start, end) range in the original. */
  from: number[];
  to: number[];
}

// Zero-width, soft hyphen, and bidi controls: invisible, so they must not split a name or number.
const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u00ad\u061c\u180e]/;

function foldDigit(ch: string): string {
  const cp = ch.codePointAt(0)!;
  if (!/^\p{Nd}$/u.test(ch) || ch.length > 1) return ch;
  // Every Nd block is a run of ten ascending digits, so the offset in the run is the value.
  let zero = cp;
  while (/^\p{Nd}$/u.test(String.fromCodePoint(zero - 1))) zero--;
  return String((cp - zero) % 10);
}

// Same-length Cyrillic/Greek look-alikes for Latin letters; used only inside tokens that already
// hold a Latin letter or digit, so genuinely Cyrillic or Greek words are left alone.
const CONFUSABLE: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'һ': 'h',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X',
  'ο': 'o', 'α': 'a', 'ν': 'v', 'ρ': 'p', 'ι': 'i', 'κ': 'k', 'τ': 't', 'υ': 'u',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
};
const RE_CONFUSABLE = new RegExp(`[${Object.keys(CONFUSABLE).join('')}]`, 'u');
const foldConfusables = (text: string) =>
  text.replace(/[\p{L}\p{N}]+/gu, (tok) =>
    /[A-Za-z0-9]/.test(tok) && RE_CONFUSABLE.test(tok)
      ? tok.replace(new RegExp(RE_CONFUSABLE.source, 'gu'), (c) => CONFUSABLE[c]!)
      : tok);

/** NFKC per grapheme-ish cluster, zero-width stripped, digits folded, with an index map. */
export function normalise(original: string): Normalised {
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  const cps = Array.from(original);
  let pos = 0;
  for (let i = 0; i < cps.length; ) {
    let cluster = cps[i]!;
    let len = cluster.length;
    i++;
    while (i < cps.length && /\p{M}/u.test(cps[i]!)) {
      cluster += cps[i]!;
      len += cps[i]!.length;
      i++;
    }
    const s = pos;
    pos += len;
    if (ZERO_WIDTH.test(cluster)) continue;
    const out = Array.from(cluster.normalize('NFKC')).map(foldDigit).join('');
    for (let k = 0; k < out.length; k++) {
      text += out[k];
      from.push(s);
      to.push(pos);
    }
  }
  // Same-length look-alike folding so the index map stays valid.
  text = foldConfusables(text);
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text
      .replace(/(?<=\d[\s.-]{0,2})[Oo](?=[\s.-]{0,2}\d)/g, '0')
      .replace(/(?<=\d[\s.-]{0,2})[lI](?=[\s.-]{0,2}\d)/g, '1');
  }
  return { text, from, to };
}

const B = '(?<![\\p{L}\\p{N}_])'; // unicode-aware word start
const E = '(?![\\p{L}\\p{N}_])'; // unicode-aware word end

// Email local parts may only start where a local-part run starts, else "a.a.a." is quadratic.
const BL = '(?<![\\p{L}\\p{N}_.%+-])';

const SPELLED = 'zero|one|two|three|four|five|six|seven|eight|nine';
const RE_EMAIL = new RegExp(
  `${BL}[a-z0-9._%+-]+@[a-z0-9-]+(?:\\.[a-z0-9-]+)+${E}`, 'giu');
const RE_EMAIL_OBF = new RegExp(
  `${BL}[a-z0-9._+-]+(?:\\s+at\\s+|\\s*[\\[(]at[\\])]\\s*)[a-z0-9-]+(?:(?:\\s+dot\\s+|\\s*[\\[(]dot[\\])]\\s*)[a-z]{2,})+${E}`, 'giu');
const RE_GOV_SHAPE = new RegExp(`${B}[A-Z]{3}-\\d{6}${E}`, 'gu');
const RE_GOV_LABELLED = new RegExp(
  `${B}(?:id|ssn|passport|national id)(?:\\s*(?:no\\.?|number|#))?\\s*[:#]?\\s*(\\d{9,12})(?!\\d)`, 'giu');
const RE_PHONE = new RegExp(
  `(?<![\\p{L}\\p{N}_])\\+?\\(?(?:(?:\\d|(?<![\\p{L}])(?:${SPELLED})(?![\\p{L}]))[\\s.\\-()]*){7,15}(?!\\d)`, 'giu');
const SUFFIX_ALT = STREET_SUFFIXES.flatMap((s) => [s, s[0]!.toUpperCase() + s.slice(1)]).join('|');
const RE_ADDRESS = new RegExp(
  `${B}\\d{1,5}\\s+(?:\\p{Lu}[\\p{Ll}'\\u2019-]+\\s+){1,3}(?:${SUFFIX_ALT})${E}`, 'gu');
const RE_PLATE = new RegExp(`${B}[A-Z]{2,3}[ -]?\\d{3,4}${E}`, 'gu');
const NOT_PLATE = new Set(['ISO', 'RFC', 'PDF', 'USB', 'COVID', 'PM', 'AM', 'UK', 'US', 'EU']);
const ROLES: Record<string, string> = {
  Mayor: 'Mayor', Councillor: 'Councillor', Cllr: 'Councillor', Minister: 'Minister',
  Senator: 'Senator', Governor: 'Governor', Director: 'Director', Commissioner: 'Commissioner',
  Sheriff: 'Sheriff', Chief: 'Chief',
};
// Capital + lower-case run, joined parts allowed (Anne-Marie, O'Neil, McDonald-smith style hyphen).
const NAME_WORD = `\\p{Lu}(?:\\p{Ll}+|['\\u2019]\\p{Lu}\\p{Ll}+)(?:['\\u2019-]\\p{Lu}?\\p{Ll}+)*`;
const RE_TITLED = new RegExp(
  `${B}(Mr|Ms|Mrs|Miss|Mx|Dr|Prof|Cllr|Councillor|Mayor|Minister|Senator|Governor|Director|Commissioner|Sheriff|Chief)\\.?\\s+${NAME_WORD}(?:\\s+${NAME_WORD})?${E}`, 'gu');
const RE_CAP_RUN = new RegExp(`${B}${NAME_WORD}(?:\\s+${NAME_WORD})+${E}`, 'gu');
const RE_FIRST = /(?<![\p{L}\p{N}_'’])(?:I|[Mm]y)(?![\p{L}\p{N}_])/gu;
const SUFFIX_SET = new Set(STREET_SUFFIXES.map((s) => s.toLowerCase()));

const DATE_LIKE = /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$|^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/;

interface Span { kind: FlagKind; start: number; end: number; suggestion?: string }

function* matches(re: RegExp, text: string) {
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) yield m;
}

export function detectPrivacyFlags(original: string): Flag[] {
  const n = normalise(original);
  const t = n.text;
  const spans: Span[] = [];
  const used = new Uint8Array(t.length); // occupancy map: overlap check is O(span), not O(spans)
  const add = (kind: FlagKind, s: number, e: number, suggestion?: string) => {
    if (e <= s || used.subarray(s, e).some(Boolean)) return;
    used.fill(1, s, e);
    spans.push({ kind, start: s, end: e, suggestion });
  };

  for (const m of matches(RE_EMAIL, t)) add('email', m.index, m.index + m[0].length);
  for (const m of matches(RE_EMAIL_OBF, t)) add('email', m.index, m.index + m[0].length);
  for (const m of matches(RE_GOV_SHAPE, t)) add('government_id', m.index, m.index + m[0].length);
  for (const m of matches(RE_GOV_LABELLED, t)) {
    const s = m.index + m[0].length - m[1]!.length;
    add('government_id', s, s + m[1]!.length);
  }
  for (const m of matches(RE_PHONE, t)) {
    const body = m[0].replace(/[\s.\-(]+$/, '');
    const digits = body.replace(/[^\d]/g, '').length +
      (body.match(new RegExp(`(?:${SPELLED})`, 'gi')) ?? []).length;
    if (digits < 7 || DATE_LIKE.test(body)) continue;
    add('phone', m.index, m.index + body.length);
  }
  for (const m of matches(RE_ADDRESS, t)) add('street_address', m.index, m.index + m[0].length);
  for (const m of matches(RE_PLATE, t)) {
    if (!NOT_PLATE.has(m[0].match(/^[A-Z]+/)![0])) add('vehicle_plate', m.index, m.index + m[0].length);
  }
  for (const m of matches(RE_TITLED, t)) {
    const role = ROLES[m[1]!];
    add('person_name', m.index, m.index + m[0].length,
      role ? `${role} of {jurisdiction}, officeholder as of {YYYY-MM}` : GENERIC_SUGGESTION);
  }
  for (const m of matches(RE_CAP_RUN, t)) {
    const words = [...m[0].matchAll(/\S+/g)].map((w) => ({ w: w[0], at: m.index + w.index }));
    while (words.length && LEADING_STOPWORDS.has(words[0]!.w)) words.shift();
    if (words.length < 2) continue;
    if (words.some((x) => INSTITUTION_WORDS.has(x.w) || SUFFIX_SET.has(x.w.toLowerCase()))) continue;
    const last = words[words.length - 1]!;
    add('person_name', words[0]!.at, last.at + last.w.length, GENERIC_SUGGESTION);
  }

  // A first-person word in the same clause, within 40 chars of a named person.
  const firsts = [...matches(RE_FIRST, t)];
  for (const p of spans.filter((x) => x.kind === 'person_name')) {
    for (const f of firsts) {
      const fs = f.index, fe = f.index + f[0].length;
      const gap = fe <= p.start ? p.start - fe : fs - p.end;
      if (gap < 0 || gap > 40) continue;
      const between = fe <= p.start ? t.slice(fe, p.start) : t.slice(p.end, fs);
      if (/[.!?;\n]/.test(between)) continue;
      spans.push({ kind: 'first_person_about_named', start: Math.min(fs, p.start), end: Math.max(fe, p.end) });
    }
  }

  const seen = new Set<string>();
  return spans
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((s): Flag => ({
      kind: s.kind,
      ruleId: RULE_FOR_KIND[s.kind],
      start: n.from[s.start]!,
      end: n.to[s.end - 1]!,
      ...(s.suggestion ? { suggestion: s.suggestion } : {}),
    }))
    .filter((f) => {
      const k = `${f.kind}:${f.start}:${f.end}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
}
