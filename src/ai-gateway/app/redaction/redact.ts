import {
  INSTITUTION_WORDS,
  LEADING_STOPWORDS,
} from '../../../problems/domain/privacy/allowlist.js';
import { detectSpans, type RawSpan, type TokenKind } from './detectors.js';
import { PrivacyGatewayError } from './errors.js';

/** One replaced span. Offsets index the ORIGINAL field text; no text is kept (decisions cite offsets only). */
export interface RedactedSpan {
  kind: TokenKind;
  start: number;
  end: number;
  token: string;
}

export interface RedactedField {
  fieldRef: string;
  text: string;
  spans: RedactedSpan[];
}

/** token to original. Personal data: callers store it encrypted and never return, log or serialise it. */
export interface TokenEntry {
  kind: TokenKind;
  token: string;
  original: string;
}

export interface Redaction {
  fields: RedactedField[];
  entries: TokenEntry[];
  redactionCount: number;
}

export const MAX_FIELD_CHARS = 20_000;
const ALLOWED_SCRIPTS =
  /(?![\p{Script=Latin}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Cyrillic}])\p{L}/u;
const TITLE =
  /^(?:Mr|Ms|Mrs|Miss|Mx|Dr|Prof|Cllr|Councillor|Mayor|Minister|Senator|Governor|Director|Commissioner|Sheriff|Chief)\.?\s+/u;
const norm = (s: string) =>
  s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Piece extends RawSpan {
  /** Pieces of one span that crosses a field boundary share a group and a token. */
  group?: number;
}

function merge(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of [...pieces].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  )) {
    const last = out[out.length - 1];
    if (last && p.start < last.end) {
      last.end = Math.max(last.end, p.end);
      last.group ??= p.group;
    } else out.push({ ...p });
  }
  return out;
}

/**
 * Deterministic redaction of all fields of one operation. Fail closed: unsupported script, oversize
 * input, a detector error, or anything still detectable (or any original still present) after
 * replacement throws `gateway_failure`, so no output exists.
 */
export function redact(
  input: readonly { fieldRef: string; text: string }[],
): Redaction {
  try {
    return run(input);
  } catch (e) {
    if (e instanceof PrivacyGatewayError) throw e;
    throw new PrivacyGatewayError('gateway_failure', 'redaction failed');
  }
}

function run(input: readonly { fieldRef: string; text: string }[]): Redaction {
  for (const f of input) {
    if (f.text.length > MAX_FIELD_CHARS)
      throw new PrivacyGatewayError(
        'gateway_failure',
        `${f.fieldRef}: too long to redact`,
      );
    if (ALLOWED_SCRIPTS.test(f.text))
      throw new PrivacyGatewayError(
        'gateway_failure',
        `${f.fieldRef}: unsupported script`,
      );
  }
  const per: Piece[][] = input.map((f) => detectSpans(f.text));

  // Spans that straddle a field boundary ("John" | "Smith"): detect on the joined text.
  const base: number[] = [];
  let joined = '';
  input.forEach((f, i) => {
    base[i] = joined.length;
    joined += f.text + (i < input.length - 1 ? ' ' : '');
  });
  let group = 0;
  if (input.length > 1)
    for (const s of detectSpans(joined)) {
      const hit = input
        .map((f, i) => ({
          i,
          from: Math.max(s.start, base[i]!),
          to: Math.min(s.end, base[i]! + f.text.length),
        }))
        .filter((h) => h.to > h.from);
      if (hit.length < 2) continue;
      group++;
      for (const h of hit)
        per[h.i]!.push({
          kind: s.kind,
          start: h.from - base[h.i]!,
          end: h.to - base[h.i]!,
          group,
        });
    }

  // Other occurrences of a detected person (full string, or a name word) are the same person.
  const aliases = new Map<string, TokenKind>();
  input.forEach((f, i) => {
    for (const p of per[i]!) {
      const orig = f.text.slice(p.start, p.end);
      if (orig.length >= 3 && p.group === undefined) aliases.set(orig, p.kind);
      if (p.kind === 'PERSON')
        for (const w of orig.replace(TITLE, '').split(/\s+/))
          if (
            w.length >= 4 &&
            !INSTITUTION_WORDS.has(w) &&
            !LEADING_STOPWORDS.has(w)
          )
            aliases.set(w, 'PERSON');
    }
  });
  input.forEach((f, i) => {
    for (const [a, kind] of aliases) {
      const rx = new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapeRe(a)}(?![\\p{L}\\p{N}_])`,
        'giu',
      );
      for (const m of f.text.matchAll(rx))
        per[i]!.push({ kind, start: m.index, end: m.index + a.length });
    }
  });

  // Tokens: same kind and same normalised original share one token within the operation.
  const tokenOf = new Map<string, string>();
  const counters = new Map<TokenKind, number>();
  const entries: TokenEntry[] = [];
  const groupText = new Map<number, string>();
  input.forEach((f, i) => {
    for (const p of merge(per[i]!))
      if (p.group !== undefined)
        groupText.set(
          p.group,
          (groupText.get(p.group) ?? '') + ' ' + f.text.slice(p.start, p.end),
        );
  });
  const tokenFor = (
    kind: TokenKind,
    original: string,
    group?: number,
  ): string => {
    const key = `${kind}:${norm(group === undefined ? original : groupText.get(group)!)}`;
    let t = tokenOf.get(key);
    if (!t) {
      const n = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, n);
      t = `[${kind}_${n}]`;
      tokenOf.set(key, t);
      entries.push({
        kind,
        token: t,
        original: group === undefined ? original : groupText.get(group)!.trim(),
      });
    }
    return t;
  };

  const fields: RedactedField[] = input.map((f, i) => {
    const spans: RedactedSpan[] = merge(per[i]!).map((p) => ({
      kind: p.kind,
      start: p.start,
      end: p.end,
      token: tokenFor(p.kind, f.text.slice(p.start, p.end), p.group),
    }));
    let text = f.text;
    for (const s of [...spans].reverse())
      text = text.slice(0, s.start) + s.token + text.slice(s.end);
    return { fieldRef: f.fieldRef, text, spans };
  });

  // Residual check: nothing detectable, and no original string, may survive.
  const out = fields
    .map((f) => f.text)
    .join('\n')
    .toLowerCase();
  for (const f of fields)
    if (detectSpans(f.text).length)
      throw new PrivacyGatewayError(
        'gateway_failure',
        `${f.fieldRef}: residual personal data`,
      );
  for (const e of entries)
    if (e.original.length >= 3 && out.includes(e.original.toLowerCase()))
      throw new PrivacyGatewayError(
        'gateway_failure',
        'residual personal data',
      );

  return {
    fields,
    entries,
    redactionCount: fields.reduce((n, f) => n + f.spans.length, 0),
  };
}

/** Replace tokens back with originals. Server side, only for the person who owns the content. */
export function expand(
  text: string,
  mapping: ReadonlyMap<string, string>,
): string {
  return text.replace(/\[[A-Z]+_\d+\]/g, (t) => mapping.get(t) ?? t);
}
