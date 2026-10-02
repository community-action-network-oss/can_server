import { HttpException } from '@nestjs/common';
import type { problem } from '../../db/schema.js';
import type { Db } from '../../db/db.module.js';
import type { Tx } from '../../db/tx.js';
import type { StructuredContentService } from '../../policy/app/structured-content.service.js';
import {
  checkPlan,
  insecureSources,
  presence,
  readiness,
  type Errors,
} from '../domain/preparation.js';
import { stampOf } from './schema-stamp.js';

type Row = typeof problem.$inferSelect;

/** Schema violations as pointers; the structured service throws, this returns. */
export async function violations(
  structured: StructuredContentService,
  tx: Tx | Db,
  row: Row,
  content: Record<string, unknown>,
  mode: 'draft' | 'submit',
): Promise<Errors> {
  const stamp = stampOf(row);
  if (!stamp) return {};
  try {
    await structured.validate(tx, 'problem', stamp, content, mode);
    return {};
  } catch (e) {
    const b = e instanceof HttpException ? e.getResponse() : null;
    const err = (
      b as { error?: { code?: string; fieldErrors?: Errors } } | null
    )?.error;
    if (err?.code === 'schema_invalid') return err.fieldErrors ?? {};
    throw e;
  }
}

/**
 * Everything T01 and the readiness endpoint look at: the pinned schema (submit mode), SOURCE-1 and CRITERIA-1,
 * https sources and the DP-STAGE-PLAN graph checks. A "no source yet" note stands in for the sources
 * (they are then marked needs_evidence). Pointers are snake_case content pointers (D-82).
 */
export async function assess(
  structured: StructuredContentService,
  tx: Tx | Db,
  row: Row,
) {
  const content = (row.content ?? {}) as Record<string, unknown>;
  const noSource =
    !!row.noSourceNote &&
    !(Array.isArray(content.sources) && content.sources.length);
  const errors: Errors = {
    ...(await violations(structured, tx, row, content, 'submit')),
  };
  if (noSource)
    for (const k of Object.keys(errors))
      if (k === '/sources' || k.startsWith('/sources/')) delete errors[k];
  // The pinned schema is the form: a stamped draft is held to what it requires (v1 requires sources and
  // final_acceptance_criteria, which is CRITERIA-1 and SOURCE-1). Without a stamp there is no schema, so presence decides.
  if (!stampOf(row)) Object.assign(errors, presence(content, row.noSourceNote));
  Object.assign(errors, insecureSources(content.sources));
  // Graph checks only make sense once the plan itself has the right shape.
  const shaped = !Object.keys(errors).some(
    (k) =>
      k.startsWith('/stage_plan') || k.startsWith('/final_acceptance_criteria'),
  );
  const plan = shaped ? checkPlan(content) : { issues: [], errors: {} };
  Object.assign(errors, plan.errors);
  return {
    errors,
    content,
    readiness: readiness(errors, content, row.noSourceNote),
  };
}
