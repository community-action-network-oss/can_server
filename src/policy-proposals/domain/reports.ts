import type { ReportKind } from './stages.js';

export interface EvalRow {
  name: string;
  status: 'passed' | 'did_not_pass';
}
export interface ReplaySummary {
  verdict: string;
  changed: number;
  of: number;
  expected: number;
  unexpected: number;
  stricter: number;
  morePermissive: number;
}
type Json = Record<string, any>; // eslint-disable-line -- CI JSON, shape checked by the report schemas

const row = (name: string, pass: boolean): EvalRow => ({
  name,
  status: pass ? 'passed' : 'did_not_pass',
});

/** One row per DP check, plus one when a threshold was loosened. Names are keys, not prose. */
export function evalRows(r: Json): EvalRow[] {
  const rows: EvalRow[] = [];
  for (const dp of r.decision_points as Json[])
    for (const c of dp.checks as Json[])
      rows.push(row(`${dp.dp}.${c.metric}`, c.pass === true));
  if ((r.loosened as unknown[]).length) rows.push(row('thresholds', false));
  return rows;
}

export function replaySummary(r: Json): ReplaySummary {
  return {
    verdict: r.verdict,
    changed: r.totals.flips,
    of: r.totals.decisions,
    expected: r.totals.expected,
    unexpected: r.totals.unintended,
    stricter: r.by_direction.stricter,
    morePermissive: r.by_direction.more_permissive,
  };
}

/** The reason a report blocks the proposal, or null when it does not. */
export function blockReason(kind: ReportKind, r: Json): string | null {
  if (kind === 'eval') {
    if (r.pass === true) return null;
    const bad = evalRows(r)
      .filter((x) => x.status === 'did_not_pass')
      .map((x) => x.name);
    return bad.length ? bad.join(', ') : 'eval_did_not_pass';
  }
  if (r.verdict !== 'blocked') return null;
  return (r.blockers as string[]).join('; ') || 'replay_blocked';
}

/** Eval report as emitted by can_policy tools/eval.mjs --json. Loose on purpose: the tool owns the rest of the shape. */
export const EVAL_REPORT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'eval-report.schema.json',
  type: 'object',
  required: ['version', 'pass', 'loosened', 'decision_points'],
  properties: {
    version: { const: 1 },
    pass: { type: 'boolean' },
    loosened: { type: 'array', maxItems: 1000 },
    decision_points: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        required: ['dp', 'checks'],
        properties: {
          dp: { type: 'string', maxLength: 80 },
          checks: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              required: ['metric', 'pass'],
              properties: {
                metric: { type: 'string', maxLength: 80 },
                pass: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  },
} as const;
