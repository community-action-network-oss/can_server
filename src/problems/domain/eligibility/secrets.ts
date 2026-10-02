import { normalise } from '../privacy/detect.js';

export interface SecretFlag {
  kind: 'secret';
  ruleId: 'PRIV-GATE-1';
  /** Offsets into the ORIGINAL text, end exclusive. */
  start: number;
  end: number;
}

const RES = [
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  /-----BEGIN[ A-Z]*/g,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  // long hex/base64 run shortly after a secret-ish word
  /\b(?:password|passwd|secret|api[ _-]?key|key|token)\b[^A-Za-z0-9]{0,6}(?:is\s+)?[:=]?\s*[A-Za-z0-9+/_=-]{24,}/gi,
];

export function findSecrets(original: string): SecretFlag[] {
  const n = normalise(original);
  const spans: [number, number][] = [];
  for (const re of RES) {
    for (const m of n.text.matchAll(re)) {
      const a = m.index!;
      spans.push([n.from[a]!, n.to[a + m[0].length - 1]!]);
    }
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: SecretFlag[] = [];
  for (const [start, end] of spans) {
    const last = out[out.length - 1];
    if (last && start < last.end) { last.end = Math.max(last.end, end); continue; }
    out.push({ kind: 'secret', ruleId: 'PRIV-GATE-1', start, end });
  }
  return out;
}
