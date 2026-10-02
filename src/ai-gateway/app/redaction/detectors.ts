import {
  detectPrivacyFlags,
  type FlagKind,
} from '../../../problems/domain/privacy/detect.js';

export type TokenKind =
  | 'PERSON'
  | 'PHONE'
  | 'EMAIL'
  | 'ID'
  | 'ADDRESS'
  | 'PLATE'
  | 'SECRET'
  | 'COORD'
  | 'TIME'
  | 'PLACE'
  | 'OBFUSCATED';

/** A detected span. Offsets index the ORIGINAL text, end exclusive. */
export interface RawSpan {
  kind: TokenKind;
  start: number;
  end: number;
}

// first_person_about_named is an authoring nudge, not personal data: the person_name span inside it is redacted on its own.
const KIND: Record<FlagKind, TokenKind | null> = {
  person_name: 'PERSON',
  phone: 'PHONE',
  email: 'EMAIL',
  government_id: 'ID',
  street_address: 'ADDRESS',
  vehicle_plate: 'PLATE',
  first_person_about_named: null,
};

// --- length-preserving evasion folds, so offsets stay valid against the original ---

const CYR: Record<string, string> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  і: 'i',
  у: 'y',
  к: 'k',
  м: 'm',
  т: 't',
  н: 'h',
  в: 'b',
  ѕ: 's',
  ј: 'j',
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  Х: 'X',
  І: 'I',
  Ј: 'J',
  Ѕ: 'S',
};
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
};

const foldWord = (w: string): string => {
  // Mixed Latin and Cyrillic in one word is a homoglyph attack; a purely Cyrillic word is left alone.
  if (/\p{Script=Latin}/u.test(w) && /\p{Script=Cyrillic}/u.test(w))
    w = Array.from(w, (c) => CYR[c] ?? c).join('');
  // Leetspeak inside a capitalised word: "J0hn", "Sm1th".
  if (
    /^\p{Lu}[\p{L}013457@$]*$/u.test(w) &&
    /(?<=\p{L})[013457@$](?=\p{L})/u.test(w)
  )
    w = w.replace(/(?<=\p{L})[013457@$](?=\p{L})/gu, (c) => LEET[c]!);
  return w;
};

/** Same length as `text`: homoglyph and leetspeak folds per word, Devanagari digits to ASCII. */
export const foldEvasions = (text: string): string =>
  text
    .replace(/[\p{L}\p{N}@$]+/gu, foldWord)
    .replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x966));

// --- extra detectors ---

const re = (src: string, flags = 'giu') => new RegExp(src, flags);
const SECRETS: RegExp[] = [
  re('(?<![\\w-])(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}'),
  re('(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])', 'gu'),
  re('(?<![\\w])gh[pousr]_[A-Za-z0-9]{30,}'),
  re('eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}'),
  re('(?<=bearer\\s+)[A-Za-z0-9._~+/=-]{16,}'),
  re('-----BEGIN [A-Z ]*PRIVATE KEY-----'),
  // Value after a secret-looking label.
  re(
    '(?<=\\b(?:password|passwd|pwd|passcode|pin|secret|api[ _-]?key|token)\\s*(?:is|=|:)\\s*)(?!\\[[A-Z]+_\\d+\\])[^\\s,;]{4,}',
  ),
  // Long opaque strings that mix letters and digits.
  re(
    '(?<![\\w+/=-])(?=[A-Za-z0-9+/_-]*\\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}={0,2}',
  ),
];
const COORDS: RegExp[] = [
  re(
    '(?<![\\d.])[-+]?\\d{1,3}\\.\\d{3,}\\s*[,;/]\\s*[-+]?\\d{1,3}\\.\\d{3,}(?![\\d.])',
  ),
  re(
    '\\d{1,3}\\s?[°º]\\s?\\d{1,2}\\s?[\'′]?(?:\\s?\\d{1,2}(?:\\.\\d+)?\\s?["″]?)?\\s?[NS]\\b[\\s,;]*\\d{1,3}\\s?[°º]\\s?\\d{1,2}\\s?[\'′]?(?:\\s?\\d{1,2}(?:\\.\\d+)?\\s?["″]?)?\\s?[EW]\\b',
  ),
];
const W = '[\\p{L}\\p{M}]+';
const NAME_CUES: RegExp[] = [
  // Arabic and Devanagari have no capitals, so a person is found by the honorific in front.
  re(
    `(?<![\\p{L}\\p{M}])[بلوك]?(?:ال(?:سيد|سيدة|أستاذ|استاذ|دكتور|دكتورة|شيخ|مهندس|حاج|حاجة)|سيد|سيدة|دكتور|دكتورة)\\s+${W}(?:\\s+${W}){0,2}`,
  ),
  re(
    `(?<![\\p{L}\\p{M}])(?:श्रीमान|श्रीमती|सुश्री|श्री|डॉक्टर|डॉ\\.?)\\s*${W}(?:\\s+${W}){0,2}`,
  ),
];
const SPACED = re(
  '(?<![\\p{L}\\p{N}])(?:\\p{L}[ _-]){3,}\\p{L}(?![\\p{L}\\p{N}])',
);

// Role + place + time together can single a person out even with no name: coarsen the place and time.
const ROLE = re(
  '(?<![\\p{L}])(?:nurse|teacher|officer|manager|clerk|driver|doctor|caretaker|landlord|inspector|supervisor|receptionist|guard|warden)(?![\\p{L}])',
);
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
const TIMES: RegExp[] = [
  re('(?<![\\d:.])\\d{1,2}[:.]\\d{2}\\s?(?:am|pm)?(?![\\d])'),
  re('(?<![\\d])\\d{1,2}\\s?(?:am|pm)(?![\\p{L}])'),
  re(
    `(?<![\\d])\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:\\s+\\d{4})?(?![\\p{L}])`,
  ),
  re(
    `(?<![\\p{L}])${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?(?![\\d])`,
  ),
];
const PLACES: RegExp[] = [
  re(
    '(?<![\\p{L}])(?:[Ww]ard|[Rr]oom|[Ff]loor|[Uu]nit|[Bb]lock|[Bb]uilding|[Dd]epot|[Bb]ranch|[Bb]ay|[Dd]esk|[Cc]ounter)\\s+(?:\\p{Lu}|\\d)[\\p{L}\\d-]*',
    'gu',
  ),
];

const has = (rx: RegExp, text: string): boolean =>
  new RegExp(rx.source, rx.flags.replace('g', '')).test(text);

function all(rx: RegExp, text: string, kind: TokenKind, out: RawSpan[]): void {
  rx.lastIndex = 0;
  for (const m of text.matchAll(rx))
    if (m[0].length)
      out.push({ kind, start: m.index, end: m.index + m[0].length });
}

/** Every span of personal data in `text`, as offsets into `text`. Union of the 03-u02 detector (run on the original and the evasion-folded text) and the extras. */
export function detectSpans(text: string): RawSpan[] {
  const out: RawSpan[] = [];
  const folded = foldEvasions(text);
  for (const t of folded === text ? [text] : [text, folded])
    for (const f of detectPrivacyFlags(t)) {
      const kind = KIND[f.kind];
      if (kind) out.push({ kind, start: f.start, end: f.end });
    }
  for (const rx of SECRETS) all(rx, text, 'SECRET', out);
  for (const rx of COORDS) all(rx, text, 'COORD', out);
  for (const rx of NAME_CUES) all(rx, folded, 'PERSON', out);
  all(SPACED, text, 'OBFUSCATED', out);
  if (
    has(ROLE, text) &&
    TIMES.some((r) => has(r, text)) &&
    PLACES.some((r) => has(r, text))
  ) {
    for (const r of TIMES) all(r, text, 'TIME', out);
    for (const r of PLACES) all(r, text, 'PLACE', out);
  }
  return out;
}
