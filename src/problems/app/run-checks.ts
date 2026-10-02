import { checkEvidenceUrl } from '../domain/eligibility/url.js';
import { classifyStatement } from '../domain/eligibility/classify.js';
import { detectScript } from '../domain/eligibility/language.js';
import {
  LIMITS,
  checkLimits,
  type LimitField,
} from '../domain/eligibility/limits.js';
import { findSecrets } from '../domain/eligibility/secrets.js';
import { detectPrivacyFlags } from '../domain/privacy/detect.js';

/** Plain columns that hold author text. Keys in flags are these names, or JSON pointers ("/...") into content or evidence. */
export const TEXT_FIELDS = [
  'title',
  'condition',
  'affected',
  'coarseArea',
  'desiredOutcome',
  'observed',
  'uncertain',
] as const;

export interface CheckInput {
  fields: Partial<Record<(typeof TEXT_FIELDS)[number], string | null>>;
  content?: unknown;
  evidence?: { url: string; note: string }[] | null;
  notes?: { noEvidenceNote?: string | null; noSourceNote?: string | null };
}
export interface CheckFlag {
  /** Stable for the same text: field, kind and span. */
  id: string;
  field: string;
  kind: string;
  ruleId: string;
  start: number;
  end: number;
  suggestion?: string;
  severity: 'hard' | 'review';
}
export interface CheckResult {
  flags: CheckFlag[];
  emergency: boolean;
  languageLabel: string | null;
  /** The text the repost sketch is built from; never returned or stored. */
  statement: string;
}

// Author may keep these with an explicit "Keep as is" (NAME-1 and address candidates); everything else is hard.
const REVIEW_KINDS = new Set([
  'person_name',
  'first_person_about_named',
  'street_address',
]);

function* strings(v: unknown, at = ''): Generator<[string, string]> {
  if (typeof v === 'string') yield [at, v];
  else if (Array.isArray(v))
    for (const [i, x] of v.entries()) yield* strings(x, `${at}/${i}`);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v))
      yield* strings(x, `${at}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`);
}

const emergency = (t: string) => {
  const c = classifyStatement(t);
  return !c.ok && c.ineligibilityCode === 'emergency';
};

const LIMIT_RULE = 'LIMIT-1';

/** Pure and deterministic. Spans index the original text. */
export function runChecks(i: CheckInput): CheckResult {
  const flags: CheckFlag[] = [];
  const add = (
    field: string,
    kind: string,
    ruleId: string,
    start: number,
    end: number,
    suggestion?: string,
  ) =>
    flags.push({
      id: `${field}:${kind}:${start}-${end}`,
      field,
      kind,
      ruleId,
      start,
      end,
      ...(suggestion && { suggestion }),
      severity: REVIEW_KINDS.has(kind) ? 'review' : 'hard',
    });

  const texts: [string, string][] = [];
  for (const k of TEXT_FIELDS) {
    const v = i.fields[k];
    if (typeof v === 'string') texts.push([k, v]);
  }
  for (const k of ['noEvidenceNote', 'noSourceNote'] as const) {
    const v = i.notes?.[k];
    if (typeof v === 'string') texts.push([k, v]);
  }
  for (const [n, e] of (i.evidence ?? []).entries())
    texts.push([`/intakeEvidence/${n}/note`, e.note ?? '']);
  for (const [p, v] of strings(i.content, '/content')) texts.push([p, v]);

  for (const [field, text] of texts) {
    for (const f of detectPrivacyFlags(text))
      add(field, f.kind, f.ruleId, f.start, f.end, f.suggestion);
    for (const f of findSecrets(text))
      add(field, 'secret', f.ruleId, f.start, f.end);
  }
  for (const v of checkLimits(
    Object.fromEntries(texts.filter(([k]) => k in LIMITS)) as Partial<
      Record<LimitField, string>
    >,
  ).violations)
    add(v.field, 'over_length', LIMIT_RULE, v.max, v.length);
  for (const [n, e] of (i.evidence ?? []).entries()) {
    // ponytail: https only; allowHttp is for local development and stays off here.
    if (!checkEvidenceUrl(e.url ?? '').ok)
      add(
        `/intakeEvidence/${n}/url`,
        'evidence_url',
        'EVID-URL-1',
        0,
        (e.url ?? '').length,
      );
  }
  flags.sort((a, b) => a.field.localeCompare(b.field) || a.start - b.start);

  const statement = TEXT_FIELDS.map((k) => i.fields[k])
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
  const script = detectScript(statement);
  return {
    flags,
    emergency: emergency(statement),
    languageLabel: script.supported ? null : script.label,
    statement,
  };
}
