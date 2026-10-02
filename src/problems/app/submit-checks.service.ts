import { Inject, Injectable, Optional } from '@nestjs/common';
import { problem, type KeptFlag } from '../../db/schema.js';
import type { Tx } from '../../db/tx.js';
import { ApiException } from '../../platform/errors.js';
import {
  StructuredContentService,
  schemaError,
} from '../../policy/app/structured-content.service.js';
import { changedPaths } from '../domain/preparation.js';
import { assess } from './preparation.js';
import {
  NoopReviewHooks,
  REVIEW_HOOKS,
  type ReviewHooks,
} from './transition-ports.js';
import { FingerprintRepo } from '../infra/fingerprint.repo.js';
import { stampOf } from './schema-stamp.js';
import { runChecks, TEXT_FIELDS, type CheckFlag } from './run-checks.js';

export const FINGERPRINTS = Symbol('FingerprintRepo');
type Row = typeof problem.$inferSelect;

export const checkInputOf = (r: Row) => ({
  fields: Object.fromEntries(TEXT_FIELDS.map((k) => [k, r[k]])),
  content: r.content,
  evidence: r.intakeEvidence,
  notes: { noEvidenceNote: r.noEvidenceNote, noSourceNote: r.noSourceNote },
});
const snapshotOf = (r: Row) => ({
  ...checkInputOf(r).fields,
  content: r.content,
  evidence: r.intakeEvidence,
});

// jsonb does not keep key order, so compare with sorted keys.
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : x,
  );

/** The synchronous gate for T01 and T03 (PRIV-GATE-1). Runs inside the transition transaction; any throw leaves the state unchanged (PUB-FAILCLOSED-1). */
@Injectable()
export class SubmitChecks {
  constructor(
    @Inject(StructuredContentService)
    private readonly structured: StructuredContentService,
    @Inject(FINGERPRINTS) private readonly fingerprints: FingerprintRepo,
    @Optional()
    @Inject(REVIEW_HOOKS)
    public hooks: ReviewHooks = new NoopReviewHooks(),
  ) {}

  async check(r: Row, now: Date) {
    const res = runChecks(checkInputOf(r));
    const repostMatch = res.statement
      ? await this.fingerprints.findSimilar(
          this.fingerprints.sketch(res.statement),
          now,
        )
      : false;
    return { ...res, repostMatch };
  }

  /** Throws validation_failed with per-field errors, or returns the columns to set on success. */
  async gate(
    tx: Tx,
    r: Row,
    transitionId: 'T01' | 'T03',
    fields: Record<string, unknown>,
    now: Date,
  ): Promise<Partial<typeof problem.$inferInsert>> {
    const stamp = stampOf(r);
    // Completeness against the pinned schema (10-u29), plus SOURCE-1, CRITERIA-1 and the stage plan graph (12-u04).
    // ponytail: a draft with no schema stamp (no active pack when it was made) skips these; it cannot get past review anyway.
    if (stamp) {
      const a = await assess(this.structured, tx, r);
      if (Object.keys(a.errors).length)
        throw schemaError('schema_invalid', 'Some answers need attention.', {
          fieldErrors: a.errors,
        });
    }

    const res = await this.check(r, now);
    const kept = new Set((r.keptFlags ?? []).map((k) => k.id));
    const errs: Record<string, string> = {};
    const note = (f: CheckFlag) =>
      (errs[f.field] ??= `${f.kind} at ${f.start}-${f.end} (${f.ruleId})`);
    for (const f of res.flags)
      if (f.severity === 'hard' || !kept.has(f.id)) note(f);
    if (res.emergency && fields.emergencyAcknowledged !== true)
      errs.emergencyAcknowledged = 'required';
    const prev = r.submitSnapshot;
    if (
      transitionId === 'T03' &&
      prev &&
      stable(prev.fields) === stable(snapshotOf(r))
    )
      errs.changedFlaggedField = 'Change at least one flagged field first.';
    if (Object.keys(errs).length)
      throw new ApiException(
        400,
        'validation_failed',
        'Some fields need attention before review.',
        errs,
      );
    // T03: recommendations on the changed paths reopen (RECO-1); the review module owns what that means.
    if (transitionId === 'T03' && prev)
      await this.hooks.reopen(
        tx,
        r.id,
        changedPaths(
          (prev.fields.content ?? {}) as Record<string, unknown>,
          (r.content ?? {}) as Record<string, unknown>,
        ),
      );
    return {
      privacyCheckId: crypto.randomUUID(),
      privacyCheckAt: now,
      repostMatch: res.repostMatch,
      // Only flags that still exist stay kept; the rest are stale offsets.
      keptFlags: (r.keptFlags ?? []).filter((k) =>
        res.flags.some((f) => f.id === k.id),
      ),
      submitSnapshot: { version: r.version + 1, fields: snapshotOf(r) },
    };
  }

  keep(flags: CheckFlag[], ids: string[]): KeptFlag[] {
    const bad = ids.filter(
      (id) => !flags.some((f) => f.id === id && f.severity === 'review'),
    );
    if (bad.length)
      throw new ApiException(
        400,
        'validation_failed',
        'Those flags cannot be kept.',
        {
          flagIds: 'Only current review flags can be kept.',
        },
      );
    return flags
      .filter((f) => ids.includes(f.id))
      .map(({ id, field, kind, ruleId, start, end }) => ({
        id,
        field,
        kind,
        ruleId,
        start,
        end,
      }));
  }
}
