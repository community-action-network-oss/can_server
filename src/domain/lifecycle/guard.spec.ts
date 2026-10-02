import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  evaluateTransition,
  type GuardContext,
  type Target,
} from './guard.js';
import {
  TRANSITIONS,
  oldToNewTransitionId,
  type ActorKind,
  type Transition,
} from './table.js';
import { STATES, type State } from './vocabulary.js';

const ACTORS: ActorKind[] = ['initiator', 'run', 'lane', 'system'];
const ALL_COND: GuardContext = {
  runId: 'run-1',
  noOtherAcceptedContribution: true,
  feasibilityPassed: true,
  everyRequiredStageResolvedOrSkipped: true,
  noRemainingRequiredStageCanProceed: true,
  atLeastOneCompletedReview: true,
  reviewQuorumMetOrPosterOverride: true,
};
const fieldsFor = (t: Transition) =>
  Object.fromEntries(t.required.map((k) => [k, 'x']));
const row = (id: string) => TRANSITIONS.find((t) => t.id === id)!;
const targets = (t: Transition, from: State | 'none'): Target[] =>
  t.to === 'same'
    ? [from as State]
    : t.to === 'resume_state'
      ? ['draft', 'in_review']
      : [t.to];

// Oracle built from the table data only (not from guard code): may this actor act, given a full context?
function oracle(from: State | 'none', to: Target, actor: ActorKind): boolean {
  return TRANSITIONS.some(
    (t) =>
      t.from.includes(from) &&
      targets(t, from).includes(to) &&
      (t.actors.includes(actor) || t.proposedBy.includes(actor)),
  );
}

describe('table shape', () => {
  it('has T00 to T22 once each, in order', () => {
    expect(TRANSITIONS.map((t) => t.id)).toEqual(
      Array.from({ length: 23 }, (_, n) => `T${String(n).padStart(2, '0')}`),
    );
  });
  it('maps every old id', () => {
    expect(Object.keys(oldToNewTransitionId)).toHaveLength(25);
  });
});

const specPath = resolve(process.cwd(), '../docs/spec/01a-lifecycle.md');
describe.skipIf(!existsSync(specPath))(
  'table equals docs/spec/01a-lifecycle.md 4.2 (skipped when the superproject docs are absent)',
  () => {
    const rows = readFileSync(specPath, 'utf8')
      .split('\n## 4.3')[0]
      .split('\n')
      .filter((l) => /^\| T\d\d/.test(l))
      .map((l) => l.split(/(?<!\\)\|/).map((c) => c.trim()));
    const names = (s: string) =>
      STATES.filter((st) => new RegExp(`\\b${st}\\b`).test(s));
    // Documented mapping: "(none)" -> none; "(deleted)" -> deleted; "same state" -> same;
    // "resume state (...)" -> resume_state; otherwise the first state word. Parenthetical state words in "from" count (T22 "active (also paused)").
    const normTo = (c: string) =>
      /resume state/.test(c)
        ? 'resume_state'
        : /deleted/.test(c)
          ? 'deleted'
          : /same state/.test(c)
            ? 'same'
            : STATES.find((s) => c.startsWith(s));
    // Actor class from the cell; the trailing "; poster or steward notified" in T20 is a notification, not an actor.
    const kinds = (c: string) => {
      const a = c.replace(/;\s*poster or steward notified/, '');
      const k = new Set<string>();
      if (/moderation run/.test(a)) k.add('run');
      if (/\bposter\b/.test(a)) k.add('initiator');
      if (/\bsystem\b/.test(a)) k.add('system');
      return [...k].sort();
    };

    it('finds 23 spec rows', () => expect(rows).toHaveLength(23));
    it.each(TRANSITIONS.map((t) => [t.id, t] as const))(
      '%s matches the spec row',
      (id, t) => {
        const r = rows.find((c) => c[1].startsWith(id))!;
        expect(r, `spec row ${id}`).toBeDefined();
        const from = /\(none\)/.test(r[2]) ? ['none'] : names(r[2]);
        expect([...t.from].sort()).toEqual([...from].sort());
        expect(t.to).toBe(normTo(r[3]));
        expect([...new Set([...t.actors, ...t.proposedBy])].sort()).toEqual(
          kinds(r[4]),
        );
      },
    );
  },
);

describe('exhaustive pairs', () => {
  const froms = [...STATES, 'none'] as const;
  const tos = [...STATES, 'deleted'] as const;
  it('ok exactly when a table row allows it (full fields, conditions, run id)', () => {
    for (const from of froms)
      for (const to of tos)
        for (const actor of ACTORS) {
          const ctx = { ...ALL_COND, resumeState: to as State };
          // all rows' fields at once so no row fails on missing fields
          const fields = Object.fromEntries(
            TRANSITIONS.flatMap((t) => t.required).map((k) => [k, 'x']),
          );
          const r = evaluateTransition({
            from,
            to,
            actor,
            fields,
            context: ctx,
          });
          expect(r.ok, `${from}->${to} ${actor}`).toBe(oracle(from, to, actor));
          if (!r.ok)
            expect(['invalid_transition', 'not_permitted']).toContain(r.code);
        }
  });
});

describe('required fields and conditions', () => {
  it.each(
    TRANSITIONS.filter((t) => t.required.length).map((t) => [t.id, t] as const),
  )('%s fails when each required field is removed', (_id, t) => {
    const actor = (t.actors[0] ?? t.proposedBy[0]) as ActorKind;
    const from = t.from[0];
    const to = targets(t, from)[0];
    const ctx = { ...ALL_COND, resumeState: to as State };
    expect(
      evaluateTransition({
        from,
        to,
        actor,
        fields: fieldsFor(t),
        context: ctx,
        transitionId: t.id,
      }).ok,
    ).toBe(true);
    for (const k of t.required) {
      const f = fieldsFor(t);
      delete f[k];
      const r = evaluateTransition({
        from,
        to,
        actor,
        fields: f,
        context: ctx,
        transitionId: t.id,
      });
      expect(r).toMatchObject({
        ok: false,
        code: 'missing_fields',
        missing: [k],
      });
    }
  });
  it('T01 without finalAcceptanceCriteria fails (CRITERIA-1); a no-source note satisfies sources', () => {
    const f = fieldsFor(row('T01'));
    const base = {
      from: 'draft',
      to: 'in_review',
      actor: 'initiator',
    } as const;
    delete (f as Record<string, unknown>).finalAcceptanceCriteria;
    expect(evaluateTransition({ ...base, fields: f })).toMatchObject({
      code: 'missing_fields',
      missing: ['finalAcceptanceCriteria'],
    });
    const g = { ...fieldsFor(row('T01')), noSourceNote: 'none yet' } as Record<
      string,
      unknown
    >;
    delete g.sources;
    expect(evaluateTransition({ ...base, fields: g }).ok).toBe(true);
  });
  it('every condition blocks a decision when false', () => {
    for (const t of TRANSITIONS.filter((x) => x.conditions.length))
      for (const c of t.conditions) {
        const actor = t.actors[0] as ActorKind;
        const from = t.from[0];
        const r = evaluateTransition({
          from,
          to: targets(t, from)[0],
          actor,
          fields: fieldsFor(t),
          context: { ...ALL_COND, [c]: false, resumeState: 'draft' },
          transitionId: t.id,
        });
        expect(r, `${t.id} ${c}`).toMatchObject({
          ok: false,
          code: 'condition_failed',
        });
      }
  });
});

describe('who decides', () => {
  const runDecided = [
    'T02',
    'T04',
    'T05',
    'T13',
    'T14',
    'T15',
    'T16',
    'T17',
    'T20',
    'T21',
    'T22',
  ];
  it('no human (initiator) or lane actor ever decides a run-gated transition', () => {
    for (const id of runDecided) {
      const t = row(id);
      for (const actor of ['initiator', 'lane'] as const) {
        const r = evaluateTransition({
          from: t.from[0],
          to: targets(t, t.from[0])[0],
          actor,
          fields: fieldsFor(t),
          context: ALL_COND,
          transitionId: id,
        });
        if (r.ok) expect(r.mode, `${id} ${actor}`).toBe('propose');
        else expect(r.code).toBe('not_permitted');
      }
    }
  });
  it('the initiator only proposes T13 to T17 and T22, nothing else of the run set', () => {
    for (const id of runDecided) {
      const t = row(id);
      const r = evaluateTransition({
        from: t.from[0],
        to: targets(t, t.from[0])[0],
        actor: 'initiator',
        fields: fieldsFor(t),
        context: ALL_COND,
        transitionId: id,
      });
      expect(r.ok).toBe(
        ['T13', 'T14', 'T15', 'T16', 'T17', 'T22'].includes(id),
      );
    }
  });
  it('a run without a run id is not permitted', () => {
    const t = row('T04');
    expect(
      evaluateTransition({
        from: 'in_review',
        to: 'active',
        actor: 'run',
        fields: fieldsFor(t),
        context: { ...ALL_COND, runId: undefined },
      }),
    ).toMatchObject({ code: 'not_permitted' });
  });
  it('system may propose T15; T08 to T10 are system only', () => {
    expect(
      evaluateTransition({
        from: 'active',
        to: 'solved',
        actor: 'system',
        fields: fieldsFor(row('T15')),
      }),
    ).toMatchObject({ ok: true, mode: 'propose' });
    for (const id of ['T08', 'T09', 'T10'])
      expect(row(id).actors).toEqual(['system']);
  });
  it('T04 is refused with zero completed reviews (REVIEW-1)', () => {
    const r = evaluateTransition({
      from: 'in_review',
      to: 'active',
      actor: 'run',
      fields: fieldsFor(row('T04')),
      context: { ...ALL_COND, atLeastOneCompletedReview: false },
    });
    expect(r).toMatchObject({
      ok: false,
      code: 'condition_failed',
      transitionId: 'T04',
    });
  });
  it('T20 and T21 are refused without feasibility, and from withdrawn and rejected', () => {
    for (const id of ['T20', 'T21']) {
      const t = row(id);
      const f = fieldsFor(t);
      expect(
        evaluateTransition({
          from: 'solved',
          to: 'active',
          actor: 'run',
          fields: f,
          context: { ...ALL_COND, feasibilityPassed: false },
          transitionId: id,
        }),
      ).toMatchObject({ code: 'condition_failed' });
      for (const from of ['withdrawn', 'rejected'] as const)
        expect(
          evaluateTransition({
            from,
            to: 'active',
            actor: 'run',
            fields: f,
            context: ALL_COND,
            transitionId: id,
          }),
        ).toMatchObject({ ok: false, code: 'invalid_transition' });
    }
  });
  it('T18 needs no other accepted contribution; T10 resumes only the remembered state', () => {
    expect(
      evaluateTransition({
        from: 'active',
        to: 'withdrawn',
        actor: 'initiator',
        context: { noOtherAcceptedContribution: false },
      }),
    ).toMatchObject({ code: 'condition_failed' });
    const f = { completedRunId: 'r' };
    expect(
      evaluateTransition({
        from: 'held',
        to: 'draft',
        actor: 'system',
        fields: f,
        context: { resumeState: 'draft' },
      }).ok,
    ).toBe(true);
    expect(
      evaluateTransition({
        from: 'held',
        to: 'in_review',
        actor: 'system',
        fields: f,
        context: { resumeState: 'draft' },
      }).ok,
    ).toBe(false);
    expect(
      evaluateTransition({
        from: 'held',
        to: 'active',
        actor: 'system',
        fields: f,
        context: { resumeState: 'active' },
      }).ok,
    ).toBe(false);
  });
  it('T22 keeps the state (active or paused)', () => {
    const f = fieldsFor(row('T22'));
    expect(
      evaluateTransition({
        from: 'paused',
        to: 'paused',
        actor: 'run',
        fields: f,
        context: ALL_COND,
      }).ok,
    ).toBe(true);
    expect(
      evaluateTransition({
        from: 'paused',
        to: 'active',
        actor: 'run',
        fields: f,
        context: ALL_COND,
        transitionId: 'T22',
      }).ok,
    ).toBe(false);
  });
});

describe('property', () => {
  it('random inputs are ok only when the table allows (no conditions or fields bypass the table)', () => {
    const allFields = Object.fromEntries(
      TRANSITIONS.flatMap((t) => t.required).map((k) => [k, 'x']),
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...STATES, 'none' as const),
        fc.constantFrom(...STATES, 'deleted' as const),
        fc.constantFrom(...ACTORS),
        fc.boolean(),
        fc.subarray(Object.keys(allFields)),
        fc.option(fc.constantFrom(...STATES), { nil: undefined }),
        (from, to, actor, withRun, keys, resumeState) => {
          const fields = Object.fromEntries(keys.map((k) => [k, 'x']));
          const r = evaluateTransition({
            from,
            to,
            actor,
            fields,
            context: { runId: withRun ? 'r' : undefined, resumeState },
          });
          if (r.ok) expect(oracle(from, to, actor)).toBe(true);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe('allowedTransitions', () => {
  it('lists what an actor can act on', () => {
    expect(allowedTransitions('draft', 'initiator').map((t) => t.id)).toEqual([
      'T01',
      'T19',
    ]);
    expect(
      allowedTransitions('in_review', 'initiator').map((t) => t.id),
    ).toEqual(['T06']);
    expect(allowedTransitions('active', 'initiator').map((t) => t.id)).toEqual([
      'T11',
      'T13',
      'T15',
      'T16',
      'T17',
      'T18',
      'T22',
    ]);
    expect(allowedTransitions('rejected', 'run')).toEqual([]);
  });
});
