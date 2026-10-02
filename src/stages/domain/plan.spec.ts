import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CLASSIC_5, ONE_STAGE } from './templates.js';
import { validatePlan, topoOrder } from './plan.js';
import {
  canStart,
  finalCheckDue,
  problemChip,
  readyStages,
  successorsAfterReopen,
} from './gating.js';
import {
  allowedContributionTypes,
  allowedForProblemLevel,
  CONTRIBUTION_TYPES,
} from './contribution-matrix.js';
import {
  STAGE_STATES,
  type Stage,
  type StagePlan,
  type StageStates,
} from './types.js';

const C = [{ id: 'c', statement: 's', measure: 'm' }];
const st = (
  id: string,
  dependsOn: string[] = [],
  over: Partial<Stage> = {},
): Stage => ({
  id,
  name: id,
  goal: 'g',
  decisionMethod: 'poster_after_input',
  required: true,
  needsChoice: true,
  autoStart: true,
  dependsOn,
  criteria: C,
  ...over,
});
const plan = (stages: Stage[], finalCriteria = C): StagePlan => ({
  planVersion: 1,
  stages,
  finalCriteria,
});
const codes = (p: StagePlan) => validatePlan(p).issues.map((i) => i.code);
const states = (p: StagePlan, over: StageStates = {}): StageStates => ({
  ...Object.fromEntries(p.stages.map((s) => [s.id, 'planned'])),
  ...over,
});

const serial = plan([st('a'), st('b', ['a']), st('c', ['b'])]);
const parallel = plan([st('a'), st('b'), st('c')]);
const diamond = plan([
  st('a'),
  st('b', ['a']),
  st('c', ['a']),
  st('d', ['b', 'c']),
]);
const mixed = plan([st('a'), st('b'), st('c', ['a']), st('d', ['b', 'c'])]);

describe('templates and ordering', () => {
  it('classic-5 and one-stage validate', () => {
    expect(validatePlan(CLASSIC_5)).toEqual({ ok: true, issues: [] });
    expect(validatePlan(ONE_STAGE(C))).toEqual({ ok: true, issues: [] });
    expect(topoOrder(CLASSIC_5)).toEqual([
      'facts',
      'solutions',
      'choose',
      'implement',
      'verify',
    ]);
    expect(ONE_STAGE(C).stages[0].criteria).toEqual(C);
  });
  it('topoOrder puts a stage after its predecessors', () => {
    expect(topoOrder(diamond)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('validatePlan rejections', () => {
  it('cycle with its path', () => {
    const p = plan([st('a', ['c']), st('b', ['a']), st('c', ['b']), st('z')]);
    const issue = validatePlan(p).issues.find((i) => i.code === 'cycle')!;
    expect(issue).toMatchObject({ path: ['a', 'c', 'b', 'a'] });
    expect(() => topoOrder(p)).toThrow();
  });
  it('dangling edge, no start node, no criteria, no final criteria, duplicate name', () => {
    expect(codes(plan([st('a', ['ghost'])]))).toContain('dangling_edge');
    expect(codes(plan([st('a', ['b']), st('b', ['a'])]))).toContain(
      'no_start_node',
    );
    expect(codes(plan([st('a', [], { criteria: [] })]))).toContain(
      'no_criteria',
    );
    expect(codes(plan([st('a')], []))).toContain('no_final_criteria');
    expect(
      codes(plan([st('a', [], { name: 'X' }), st('b', [], { name: 'x' })])),
    ).toContain('duplicate_name');
  });
  it('required stage that leads only to non-required sinks', () => {
    const p = plan([st('a'), st('b', ['a'], { required: false })]);
    expect(validatePlan(p).issues).toContainEqual({
      code: 'unreachable_from_final',
      stageId: 'a',
    });
    expect(
      validatePlan(plan([st('a'), st('b', [], { required: false })])).ok,
    ).toBe(true);
  });
  it('required sink with no final criteria is a dead end', () => {
    expect(codes(plan([st('a')], []))).toContain('dead_end_required');
  });
  it('shapes validate', () => {
    for (const p of [serial, parallel, diamond, mixed])
      expect(validatePlan(p).ok).toBe(true);
  });
});

describe('gating tables', () => {
  it('ready sets as states change', () => {
    const cases: [StagePlan, StageStates, string[]][] = [
      [serial, states(serial), ['a']],
      [serial, states(serial, { a: 'resolved' }), ['b']],
      [serial, states(serial, { a: 'active' }), []],
      [parallel, states(parallel), ['a', 'b', 'c']],
      [diamond, states(diamond, { a: 'resolved', b: 'resolved' }), ['c']],
      [
        diamond,
        states(diamond, { a: 'resolved', b: 'resolved', c: 'resolved' }),
        ['d'],
      ],
      [mixed, states(mixed, { a: 'resolved' }), ['b', 'c']],
      [ONE_STAGE(C), states(ONE_STAGE(C)), ['resolve']],
      [CLASSIC_5, states(CLASSIC_5, { facts: 'resolved' }), ['solutions']],
    ];
    for (const [p, s, want] of cases) expect(readyStages(p, s)).toEqual(want);
  });
  it('a skipped stage counts for gating', () => {
    expect(readyStages(serial, states(serial, { a: 'skipped' }))).toEqual([
      'b',
    ]);
  });
  it('blocked stops its own branch only', () => {
    const s = states(mixed, { a: 'blocked', b: 'resolved' });
    expect(readyStages(mixed, s)).toEqual([]);
    const p = plan([st('a'), st('b'), st('c', ['a']), st('d', ['b'])]);
    expect(readyStages(p, states(p, { a: 'blocked', b: 'resolved' }))).toEqual([
      'd',
    ]);
  });
  it('a planned stage can never start', () => {
    expect(canStart(serial, states(serial), 'b')).toEqual({
      ok: false,
      code: 'not_ready',
    });
    expect(canStart(serial, states(serial, { a: 'ready' }), 'a')).toEqual({
      ok: true,
    });
    expect(canStart(serial, states(serial), 'nope')).toEqual({
      ok: false,
      code: 'not_ready',
    });
  });
  it('finalCheckDue when every required stage is resolved or skipped', () => {
    const p = plan([st('a'), st('b', ['a']), st('n', [], { required: false })]);
    expect(finalCheckDue(p, states(p, { a: 'resolved', b: 'skipped' }))).toBe(
      true,
    );
    expect(finalCheckDue(p, states(p, { a: 'resolved', b: 'resolving' }))).toBe(
      false,
    );
  });
  it('problem chip data', () => {
    expect(problemChip(parallel, states(parallel))).toBeNull();
    expect(problemChip(parallel, states(parallel, { b: 'active' }))).toEqual({
      kind: 'one',
      name: 'b',
    });
    expect(
      problemChip(parallel, states(parallel, { a: 'active', c: 'resolving' })),
    ).toEqual({ kind: 'many', n: 2 });
  });
  it('ST10 sends only unstarted ready successors back to planned', () => {
    const p = plan([st('a'), st('b', ['a']), st('c', ['a']), st('d', ['b'])]);
    const s = states(p, {
      a: 'resolved',
      b: 'ready',
      c: 'active',
      d: 'planned',
    });
    expect(successorsAfterReopen(p, s, 'a')).toEqual(['b']);
  });
});

describe('contribution matrix', () => {
  it('per stage state', () => {
    for (const s of ['planned', 'ready'] as const) {
      const t = allowedContributionTypes(s);
      expect(t).toHaveLength(9);
      expect(t).not.toContain('progress_update');
      expect(t).not.toContain('verification_evidence');
    }
    expect(allowedContributionTypes('active')).toEqual(CONTRIBUTION_TYPES);
    expect([...allowedContributionTypes('resolving')]).toEqual([
      'clarifying_question',
      'risk',
    ]);
    expect(allowedContributionTypes('blocked')).toHaveLength(4);
    expect(allowedContributionTypes('resolved')).toEqual([]);
    expect(allowedContributionTypes('skipped')).toEqual([]);
    expect(
      STAGE_STATES.every((s) => Array.isArray(allowedContributionTypes(s))),
    ).toBe(true);
  });
  it('per problem state', () => {
    expect(allowedForProblemLevel('active')).toEqual(CONTRIBUTION_TYPES);
    expect([...allowedForProblemLevel('paused')]).toEqual([
      'clarifying_question',
      'progress_update',
    ]);
    expect(allowedForProblemLevel('stuck')).toHaveLength(2);
    expect(allowedForProblemLevel('closed')).toEqual([]);
    expect(allowedForProblemLevel('solved')).toEqual([]);
  });
});

// Random DAG: stage i may depend on any earlier stage.
const dagArb = fc.integer({ min: 1, max: 9 }).chain((n) =>
  fc
    .tuple(
      fc.array(fc.array(fc.boolean(), { minLength: n, maxLength: n }), {
        minLength: n,
        maxLength: n,
      }),
      fc.array(fc.nat(), { minLength: n * 3, maxLength: n * 3 }),
      fc.array(fc.boolean(), { minLength: n, maxLength: n }),
    )
    .map(([m, picks, skip]) => ({
      p: plan(
        Array.from({ length: n }, (_, i) =>
          st(
            `s${i}`,
            m[i]
              .slice(0, i)
              .map((b, j) => (b ? `s${j}` : ''))
              .filter(Boolean),
          ),
        ),
      ),
      picks,
      skip,
    })),
);

describe('STAGE-GATE-1 property', () => {
  it('never ready with an unsettled predecessor, and every stage is ready exactly once', () => {
    fc.assert(
      fc.property(dagArb, ({ p, picks, skip }) => {
        expect(
          validatePlan(p).issues.filter(
            (i) => i.code === 'cycle' || i.code === 'dangling_edge',
          ),
        ).toEqual([]);
        const s = states(p);
        const readyCount: Record<string, number> = {};
        let k = 0;
        for (let guard = 0; guard < 100; guard++) {
          for (const id of readyStages(p, s)) {
            const stage = p.stages.find((x) => x.id === id)!;
            expect(
              stage.dependsOn.every(
                (d) => s[d] === 'resolved' || s[d] === 'skipped',
              ),
            ).toBe(true);
            s[id] = 'ready';
            readyCount[id] = (readyCount[id] ?? 0) + 1;
          }
          const ready = p.stages.filter((x) => s[x.id] === 'ready');
          if (ready.length === 0) break;
          const pick = ready[picks[k++ % picks.length] % ready.length];
          expect(canStart(p, s, pick.id)).toEqual({ ok: true });
          s[pick.id] = skip[p.stages.indexOf(pick)] ? 'skipped' : 'resolved';
        }
        for (const x of p.stages) expect(readyCount[x.id]).toBe(1);
        expect(finalCheckDue(p, s)).toBe(true);
        // a planned stage never starts
        for (const x of p.stages)
          if (s[x.id] === 'planned')
            expect(canStart(p, s, x.id).ok).toBe(false);
      }),
    );
  });
});
