// DP-COMPLETENESS deterministic layer (10-u29). Pure: fields come from the schema, never named here.
export interface Finding {
  field_ref: string; // JSON pointer, e.g. /fieldname
  code:
    | 'required_missing'
    | 'enum_invalid'
    | 'too_short'
    | 'too_long'
    | 'url_invalid'
    | 'list_too_short'
    | 'list_too_long'
    | 'repeated_sentence'
    | 'filler_lorem'
    | 'filler_punctuation'
    | 'filler_stopwords'
    | 'filler_same_everywhere';
}
type J = Record<string, unknown>;

const STOP = new Set(
  'a an and are as at be but by for from has have i in is it its of on or that the this to was we were will with you your they them their there here not no yes so if then than too very just what when who which do does did can could should would'.split(
    ' ',
  ),
);
const obj = (v: unknown): J =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {};
const len = (s: string) => Array.from(s).length;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const words = (s: string) => norm(s).match(/[\p{L}\p{N}']+/gu) ?? [];
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const isUrl = (s: string) => {
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname;
  } catch {
    return false;
  }
};

export function completeness(schema: J, body: J): Finding[] {
  const out: Finding[] = [];
  const props = obj(schema.properties);
  const required = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];
  const texts: [string, string][] = [];
  for (const [key, raw] of Object.entries(props)) {
    const def = obj(raw);
    const ref = '/' + key.replaceAll('~', '~0').replaceAll('/', '~1');
    const v = body[key];
    const absent =
      v === undefined ||
      v === null ||
      (typeof v === 'string' && v.trim() === '') ||
      (Array.isArray(v) && v.length === 0);
    if (absent) {
      if (required.includes(key))
        out.push({ field_ref: ref, code: 'required_missing' });
      continue;
    }
    if (Array.isArray(def.enum) && !def.enum.includes(v))
      out.push({ field_ref: ref, code: 'enum_invalid' });
    if (Array.isArray(v)) {
      const min = num(def.minItems);
      const max = num(def.maxItems);
      if (min !== undefined && v.length < min)
        out.push({ field_ref: ref, code: 'list_too_short' });
      if (max !== undefined && v.length > max)
        out.push({ field_ref: ref, code: 'list_too_long' });
      continue;
    }
    if (typeof v !== 'string') continue;
    const g = obj(def['x-guidance']);
    const min = num(def.minLength) ?? num(g.min_chars);
    const max = num(def.maxLength) ?? num(g.max_chars);
    if (min !== undefined && len(v.trim()) < min)
      out.push({ field_ref: ref, code: 'too_short' });
    if (max !== undefined && len(v) > max)
      out.push({ field_ref: ref, code: 'too_long' });
    if (obj(def['x-ui']).widget === 'url') {
      if (!isUrl(v.trim())) out.push({ field_ref: ref, code: 'url_invalid' });
      continue; // a URL is not prose
    }
    if (def.enum) continue; // enum values are not prose
    texts.push([ref, v]);
  }
  for (const [ref, v] of texts) {
    const w = words(v);
    if (/lorem ipsum|dolor sit amet/i.test(v))
      out.push({ field_ref: ref, code: 'filler_lorem' });
    else if (w.length === 0)
      out.push({ field_ref: ref, code: 'filler_punctuation' });
    else if (w.every((x) => STOP.has(x)))
      out.push({ field_ref: ref, code: 'filler_stopwords' });
  }
  const same =
    texts.length >= 2 && new Set(texts.map(([, v]) => norm(v))).size === 1;
  if (same)
    for (const [ref] of texts)
      out.push({ field_ref: ref, code: 'filler_same_everywhere' });
  // The same sentence (3+ words) in two different fields.
  const seen = new Map<string, string>();
  const flagged = new Set<string>();
  for (const [ref, v] of same ? [] : texts)
    for (const sent of v.split(/[.!?\n]+/)) {
      const k = words(sent).join(' ');
      if (words(sent).length < 3) continue;
      const first = seen.get(k);
      if (first === undefined) seen.set(k, ref);
      else if (first !== ref) {
        flagged.add(first);
        flagged.add(ref);
      }
    }
  for (const ref of flagged)
    out.push({ field_ref: ref, code: 'repeated_sentence' });
  return out;
}
