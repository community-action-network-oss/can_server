import { runChecks } from '../../problems/app/run-checks.js';
import { checkEvidenceUrl } from '../../problems/domain/eligibility/url.js';
import type { EvidenceCategory } from '../../problems/domain/eligibility/url.js';
import { ApiException } from '../../platform/errors.js';

export interface CheckedRef {
  url: string;
  note: string | null;
  category: EvidenceCategory;
}

const refsOf = (body: Record<string, unknown>) =>
  (Array.isArray(body.evidence_refs) ? body.evidence_refs : []) as {
    url?: unknown;
    supports?: unknown;
  }[];

/**
 * Deterministic checks on the structured body (privacy, naming, secrets, URL rules). Hard flags reject;
 * review flags need the author's keptFlagIds. Throws validation_failed with fieldErrors (and the flags, so the client can keep one).
 */
export function checkBody(
  body: Record<string, unknown>,
  keptFlagIds: readonly string[] = [],
): CheckedRef[] {
  const errs: Record<string, string> = {};
  const refs: CheckedRef[] = [];
  refsOf(body).forEach((r, i) => {
    const u = checkEvidenceUrl(typeof r.url === 'string' ? r.url : '');
    if (!u.ok)
      errs[`/body/evidence_refs/${i}/url`] = 'This link cannot be used.';
    else
      refs.push({
        url: u.normalized,
        note: typeof r.supports === 'string' ? r.supports : null,
        category: u.category,
      });
  });
  const res = runChecks({ fields: {}, content: body });
  const shown = [];
  for (const f of res.flags) {
    if (f.severity === 'review' && keptFlagIds.includes(f.id)) continue;
    const field = f.field.replace(/^\/content/, '/body');
    errs[field] ??= `${f.kind} at ${f.start}-${f.end} (${f.ruleId})`;
    shown.push({ ...f, field });
  }
  if (Object.keys(errs).length)
    throw new ApiException(
      400,
      'validation_failed',
      'Some answers need attention before this can be sent.',
      errs,
      {
        flags: shown.map(({ id, field, kind, ruleId, severity }) => ({
          id,
          field,
          kind,
          ruleId,
          severity,
        })),
      },
    );
  return refs;
}
