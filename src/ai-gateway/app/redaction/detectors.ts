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
  | 'OBFUSCATED'
  | 'DOB'
  | 'HANDLE'
  | 'NUMBER'
  | 'SENSITIVE';

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
    '(?<![\\d.])[-+]?\\d{1,3}\\.\\d{3,}(?:\\s*[,;/]\\s*|\\s+)[-+]?\\d{1,3}\\.\\d{3,}(?![\\d.])',
  ),
  // what3words
  re('///[a-z]+[.\\u3002][a-z]+[.\\u3002][a-z]+'),
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

// --- fix-privacy additions: names without capitals, postal codes, ids, dates of birth, handles, digits ---

const NI = re(
  '(?<![\\p{L}\\p{N}])[a-z]{2}\\s?\\d{2}\\s?\\d{2}\\s?\\d{2}\\s?[a-d](?![\\p{L}\\p{N}])',
);
const IBAN = re(
  '(?<![\\p{L}\\p{N}])[a-z]{2}\\d{2}(?:\\s?[a-z0-9]{4}){3,7}(?:\\s?[a-z0-9]{1,4})?(?![\\p{L}\\p{N}])',
);
const POSTCODES: RegExp[] = [
  // UK, Canada; US state + ZIP; any postcode/zip/pin label.
  re(
    '(?<![\\p{L}\\p{N}])[a-z]{1,2}\\d[a-z\\d]?\\s?\\d[a-z]{2}(?![\\p{L}\\p{N}])',
  ),
  re('(?<![\\p{L}\\p{N}])[a-z]\\d[a-z]\\s?\\d[a-z]\\d(?![\\p{L}\\p{N}])'),
  re('(?<=\\b[A-Z]{2}\\s)\\d{5}(?:-\\d{4})?(?!\\d)', 'gu'),
  re(
    '(?<=\\b(?:post(?:al)?\\s?code|zip(?:\\s?code)?|pin\\s?code|pincode)\\s*[:#]?\\s*)[a-z0-9][a-z0-9 -]{2,8}[a-z0-9]',
  ),
];
const DATE_VAL = `(?:\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{4}[/.-]\\d{1,2}[/.-]\\d{1,2}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:,?\\s+\\d{4})?|${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{4})`;
const DOBS: RegExp[] = [
  re(
    `(?<=(?<![\\p{L}])(?:born|dob|d\\.o\\.b\\.?|date\\s+of\\s+birth|birthday)\\s*(?:on|in|is|was|:|=|-)?\\s*)${DATE_VAL}(?![\\d])`,
  ),
];
const HANDLES: RegExp[] = [
  re('(?<![\\w@.])@[a-z0-9_.]{2,30}[a-z0-9_]'),
  // a username after a cue; it must look like one (underscore or digit) so "account is overdue" is left alone.
  re(
    '(?<=(?<![\\p{L}])(?:user(?:name)?|handle|account|profile|login|insta(?:gram)?|twitter|tiktok|snap(?:chat)?|discord)\\s*(?:is|:|=|-|name|called)?\\s*@?)(?=[a-z0-9_.]*[_\\d])[a-z][a-z0-9_.]{2,30}[a-z0-9]',
  ),
  re('(?<![\\p{L}\\p{N}_])[a-z]+[_.][a-z]+[_.]?\\d{2,}(?![\\p{L}\\p{N}_])'),
];
const D = '(?:zero|one|two|three|four|five|six|seven|eight|nine)';
const SPELLED_RUN = re(
  `(?<![\\p{L}\\p{N}])(?=(?:\\d[\\s.,-]+)*${D})(?:(?:${D}|\\d)[\\s.,-]+){3,}(?:${D}|\\d)(?![\\p{L}\\p{N}])`,
);
const LONG_DIGITS = re('(?<!\\d)\\d(?:[\\s.\\-]?\\d){8,}(?!\\d)');
const DATE_LIKE_START =
  /^(?:\d{4}[-.]\d{2}[-.]\d{2}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4})\b/;

// Words that never start a name after a cue. Small on purpose: over-redaction is accepted, a miss is not.
const STOP = new Set(
  (
    'the a an this that these those it its they them their he she him her his hers we us our you your my me i ' +
    'and or but if so as at by for in of on to up is are was were be been being am do does did has have had will would ' +
    'can could should may might must not no yes any all some more most many much few other another each every both ' +
    'what which who whom whose when where why how there here then than too very just also only about after before ' +
    'again over under into onto out off down near next last first second new old good bad big small long short ' +
    'council ward office water company street road lane bin bins pipe pipes light lights lamp lamps school bus stop ' +
    'park garden housing estate repair repairs leak leaks drain drains pothole potholes noise rubbish waste litter ' +
    'police fire health service services team department city town village local public private community committee ' +
    'neighbours neighbourhood residents people someone anyone everyone nobody something anything nothing ' +
    'week weeks month months year years day days night nights time times today tomorrow yesterday monday tuesday ' +
    'wednesday thursday friday saturday sunday morning evening afternoon site project problem problems issue issues ' +
    'broken blocked flooded damaged missing urgent help support advice report reports email phone number address ' +
    'manager landlord agent builder contractor engineer officer staff worker workers volunteer volunteers charity'
  ).split(' '),
);
const NW = "[\\p{L}\\p{M}'\\u2019-]{2,}";
const nameRun = (n: number) =>
  `(?!(?:${[...STOP].join('|')})(?![\\p{L}\\p{M}]))${NW}(?:\\s+(?!(?:${[...STOP].join('|')})(?![\\p{L}\\p{M}]))${NW}){${n}}`;
const LOWER_NAMES: RegExp[] = [
  // verbs and prepositions that introduce a person: two or three words that are not common words.
  re(
    `(?<=(?<![\\p{L}])(?:ask|asked|tell|told|call|called|contact|contacted|meet|met|see|saw|email|emailed|text|texted|phone|phoned|visit|visited|with|from|by|to|name\\s+is|named|called)\\s+)${nameRun(1)}(?:\\s+${nameRun(0)})?`,
  ),
  // a relation or role followed by a single name.
  re(
    `(?<=(?<![\\p{L}])my\\s+(?:neighbou?r|landlord|boss|manager|colleague|friend|cousin|brother|sister|mother|mum|dad|father|uncle|aunt|son|daughter|husband|wife|partner|ex|teacher|doctor)\\s+(?:is\\s+|called\\s+|named\\s+)?)${nameRun(0)}(?:\\s+${nameRun(0)})?`,
  ),
];

// Special-category terms about an identifiable person (health, religion, sexuality). Applied only where a person is present.
const SENSITIVE = re(
  '(?<![\\p{L}])(?:diabet\\w*|cancer\\w*|hiv|aids|pregnan\\w*|depress\\w*|anxiety|schizo\\w*|bipolar|epilep\\w*|asthma\\w*|dementia|autis\\w*|adhd|disabled|disabilit\\w*|chemo\\w*|dialysis|psychiatr\\w*|mental\\s+health|terminal\\w*|stroke|addict\\w*|rehab|overdose|suicid\\w*|self[- ]harm|abuse[dr]?|muslim|jewish|christian|hindu|sikh|buddhist|catholic|atheist|gay|lesbian|bisexual|transgender|asylum|immigrant|refugee)(?![\\p{L}])',
);

/** Special-category spans of one text, regardless of whether a person is present. */
export const detectSensitive = (text: string): RawSpan[] => {
  const out: RawSpan[] = [];
  all(SENSITIVE, text, 'SENSITIVE', out);
  return out;
};

const MAX_DECODE = 2000;
const decodedHit = (decoded: string): boolean => {
  // Garbage decodes (control characters, replacement characters) are not text.
  if (
    !decoded ||
    [...decoded].some(
      (c) => c === '\ufffd' || (c < ' ' && !'\t\n\r'.includes(c)),
    )
  )
    return false;
  return detectCore(decoded).length > 0;
};
/** Encoded copies of personal data: percent-encoding and base64 runs. The whole run is the span. */
function encodedSpans(text: string, out: RawSpan[]): void {
  for (const m of text.matchAll(/[^\s]*%[0-9a-f]{2}[^\s]*/giu)) {
    if (m[0].length > MAX_DECODE) continue;
    let d: string;
    try {
      d = decodeURIComponent(m[0].replace(/%(?![0-9a-f]{2})/gi, '%25'));
    } catch {
      continue;
    }
    if (d !== m[0] && decodedHit(d))
      out.push({
        kind: 'OBFUSCATED',
        start: m.index,
        end: m.index + m[0].length,
      });
  }
  for (const m of text.matchAll(
    /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{16,}={0,2}(?![A-Za-z0-9+/_=-])/gu,
  )) {
    if (m[0].length > MAX_DECODE) continue;
    const d = Buffer.from(
      m[0].replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    if (decodedHit(d))
      out.push({
        kind: 'OBFUSCATED',
        start: m.index,
        end: m.index + m[0].length,
      });
  }
}

const has = (rx: RegExp, text: string): boolean =>
  new RegExp(rx.source, rx.flags.replace('g', '')).test(text);

function all(rx: RegExp, text: string, kind: TokenKind, out: RawSpan[]): void {
  rx.lastIndex = 0;
  for (const m of text.matchAll(rx))
    if (m[0].length)
      out.push({ kind, start: m.index, end: m.index + m[0].length });
}

function detectCore(text: string): RawSpan[] {
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
  for (const rx of [NI, IBAN]) all(rx, text, 'ID', out);
  for (const rx of POSTCODES) all(rx, text, 'ADDRESS', out);
  for (const rx of DOBS) all(rx, text, 'DOB', out);
  for (const rx of HANDLES) all(rx, text, 'HANDLE', out);
  for (const rx of LOWER_NAMES) all(rx, text, 'PERSON', out);
  all(SPELLED_RUN, text, 'NUMBER', out);
  for (const m of text.matchAll(LONG_DIGITS))
    if (!DATE_LIKE_START.test(m[0]))
      out.push({ kind: 'NUMBER', start: m.index, end: m.index + m[0].length });
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

/** Every span of personal data in `text`, as offsets into `text`. Union of the 03-u02 detector (run on the original and the evasion-folded text) and the extras, plus decoded copies. */
export function detectSpans(text: string): RawSpan[] {
  const out = detectCore(text);
  encodedSpans(text, out);
  if (out.some((s) => s.kind === 'PERSON')) out.push(...detectSensitive(text));
  return out;
}
