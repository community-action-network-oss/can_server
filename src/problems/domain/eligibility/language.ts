export type ScriptResult =
  | { supported: true; script: 'Latin' }
  | { supported: false; script: string; label: 'language not yet supported' };

const SCRIPTS = [
  'Latin', 'Arabic', 'Cyrillic', 'Devanagari', 'Bengali', 'Han', 'Hiragana', 'Katakana',
  'Hangul', 'Greek', 'Hebrew', 'Thai', 'Tamil', 'Telugu',
] as const;
const RES = SCRIPTS.map((s) => [s, new RegExp(`\\p{Script=${s}}`, 'gu')] as const);

/** Dominant script by letter count. Never rejects: unsupported means "route to human review" (PUB-FAILCLOSED-1). */
export function detectScript(text: string): ScriptResult {
  let best = 'Latin';
  let max = 0;
  for (const [s, re] of RES) {
    const n = text.match(re)?.length ?? 0;
    if (n > max) { max = n; best = s; }
  }
  // No letters at all (digits, empty) stays on the English path.
  return best === 'Latin'
    ? { supported: true, script: 'Latin' }
    : { supported: false, script: best, label: 'language not yet supported' };
}
