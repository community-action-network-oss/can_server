// Pure helpers for the masked review view: every string leaf of the problem goes through the masker, keyed by JSON pointer.

export interface TextField {
  fieldRef: string;
  text: string;
}
const esc = (k: string) => k.replaceAll('~', '~0').replaceAll('/', '~1');

/** Every non-empty string leaf of `v` as a field, keyed by JSON pointer under `prefix`. */
export function collectStrings(v: unknown, prefix: string): TextField[] {
  if (typeof v === 'string') return v ? [{ fieldRef: prefix, text: v }] : [];
  if (Array.isArray(v))
    return v.flatMap((x, i) => collectStrings(x, `${prefix}/${i}`));
  if (v && typeof v === 'object')
    return Object.entries(v).flatMap(([k, x]) =>
      collectStrings(x, `${prefix}/${esc(k)}`),
    );
  return [];
}

/** A copy of `v` with each string leaf replaced by its masked text. A leaf the masker did not return is dropped to '' (fail closed). */
export function applyMasked<T>(
  v: T,
  prefix: string,
  masked: ReadonlyMap<string, string>,
): T {
  const go = (x: unknown, p: string): unknown => {
    if (typeof x === 'string') return x ? (masked.get(p) ?? '') : x;
    if (Array.isArray(x)) return x.map((y, i) => go(y, `${p}/${i}`));
    if (x && typeof x === 'object')
      return Object.fromEntries(
        Object.entries(x).map(([k, y]) => [k, go(y, `${p}/${esc(k)}`)]),
      );
    return x;
  };
  return go(v, prefix) as T;
}
