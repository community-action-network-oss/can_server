// Pure guard over TRANSITIONS. No I/O. Decisions are made by recorded runs, never by a human confirmer.
import {
  TRANSITIONS,
  type ActorKind,
  type ConditionName,
  type FieldKey,
  type Transition,
} from './table.js';
import type { State } from './vocabulary.js';

export type From = State | 'none';
export type Target = State | 'deleted';
export type GuardContext = Partial<Record<ConditionName, boolean>> & {
  /** Required for any actor "run" (a recorded moderation run). */
  runId?: string;
  /** T10: the state the held problem resumes in. */
  resumeState?: State;
};
export interface GuardInput {
  from: From;
  to: Target;
  actor: ActorKind;
  fields?: Readonly<Record<string, unknown>>;
  context?: GuardContext;
  /** Disambiguates rows sharing from and to (T14 vs T20 on stuck to active). */
  transitionId?: string;
}
export type GuardResult =
  | { ok: true; transition: Transition; mode: 'direct' | 'propose' | 'decide' }
  | {
      ok: false;
      code:
        | 'invalid_transition'
        | 'not_permitted'
        | 'missing_fields'
        | 'condition_failed';
      missing?: FieldKey[];
      transitionId?: string;
    };

const has = (v: unknown) =>
  v !== undefined &&
  v !== null &&
  v !== '' &&
  !(Array.isArray(v) && v.length === 0);
// T01: sources[] or a "no source yet" note.
const present = (f: Readonly<Record<string, unknown>>, k: FieldKey) =>
  has(f[k]) || (k === 'sources' && has(f['noSourceNote']));

function matches(
  t: Transition,
  from: From,
  to: Target,
  ctx: GuardContext,
): boolean {
  if (!t.from.includes(from)) return false;
  if (t.to === 'same') return to === from;
  if (t.to === 'resume_state')
    return (to === 'draft' || to === 'in_review') && ctx.resumeState === to;
  return t.to === to;
}

function permit(
  t: Transition,
  actor: ActorKind,
  ctx: GuardContext,
): 'direct' | 'propose' | 'decide' | null {
  if (t.proposedBy.includes(actor)) return 'propose';
  if (!t.actors.includes(actor)) return null;
  if (actor === 'run') return ctx.runId ? 'decide' : null;
  return 'direct';
}

export function evaluateTransition(i: GuardInput): GuardResult {
  const ctx = i.context ?? {};
  const fields = i.fields ?? {};
  const rows = TRANSITIONS.filter(
    (t) =>
      (!i.transitionId || t.id === i.transitionId) &&
      matches(t, i.from, i.to, ctx),
  );
  if (rows.length === 0) return { ok: false, code: 'invalid_transition' };
  let fail: GuardResult | null = null;
  for (const t of rows) {
    const mode = permit(t, i.actor, ctx);
    if (!mode) continue;
    const missing = t.required.filter((k) => !present(fields, k));
    if (missing.length) {
      fail ??= {
        ok: false,
        code: 'missing_fields',
        missing,
        transitionId: t.id,
      };
      continue;
    }
    // Conditions gate the decision, not the poster's proposal (the run weighs a proposal).
    if (mode !== 'propose' && t.conditions.some((c) => ctx[c] !== true)) {
      fail ??= { ok: false, code: 'condition_failed', transitionId: t.id };
      continue;
    }
    return { ok: true, transition: t, mode };
  }
  return fail ?? { ok: false, code: 'not_permitted', transitionId: rows[0].id };
}

/** Rows an actor may act on from a state (apply or propose). The API uses this to tell the app which actions exist. */
export function allowedTransitions(from: From, actor: ActorKind): Transition[] {
  return TRANSITIONS.filter(
    (t) =>
      t.from.includes(from) &&
      (t.actors.includes(actor) || t.proposedBy.includes(actor)),
  );
}
