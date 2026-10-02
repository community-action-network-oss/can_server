import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STAGE_STATES, STAGE_CHIP } from './types.js';
import {
  STAGE_TRANSITIONS,
  evaluateStageTransition,
  type StageActor,
} from './transitions.js';

const specPath = resolve(process.cwd(), '../docs/spec/01b-stages.md');
const names: string[] = [...STAGE_STATES];

describe.skipIf(!existsSync(specPath))(
  'tables equal docs/spec/01b-stages.md (skipped when the superproject docs are absent)',
  () => {
    const md = readFileSync(specPath, 'utf8');
    const rows = md
      .split('\n')
      .filter((l) => /^\| ST\d\d \|/.test(l))
      .map((l) =>
        l
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );

    it('has ST01 to ST11 and the code has the same ids in order', () => {
      expect(rows.map((r) => r[0])).toEqual(STAGE_TRANSITIONS.map((t) => t.id));
      expect(rows).toHaveLength(11);
    });

    it('from, to and actors equal the spec rows', () => {
      for (const r of rows) {
        const t = STAGE_TRANSITIONS.find((x) => x.id === r[0])!;
        const from =
          r[1] === '(none)'
            ? ['none']
            : names.filter((n) => new RegExp(`\\b${n}\\b`).test(r[1]));
        expect([...t.from].sort(), r[0]).toEqual([...from].sort());
        const to = r[2].startsWith('prior state') ? 'prior' : r[2];
        expect(t.to, r[0]).toBe(to);
        const actors = (['steward', 'system', 'run'] as StageActor[]).filter(
          (a) => (a === 'run' ? /moderation run/.test(r[3]) : r[3].includes(a)),
        );
        // ST10 names its triggers (T20, T21, T22, an appeal), all of which are recorded runs.
        const expected = r[0] === 'ST10' ? ['run'] : actors;
        expect([...t.actors].sort(), r[0]).toEqual([...expected].sort());
      }
    });

    it('chips equal the spec text', () => {
      const chips = md
        .slice(md.indexOf('## 4b.2'), md.indexOf('## 4b.3'))
        .split('\n')
        .filter((l) =>
          /^\| `(planned|ready|active|resolving|resolved|blocked|skipped)` \|/.test(
            l,
          ),
        )
        .map((l) =>
          l
            .split('|')
            .slice(1, -1)
            .map((c) => c.trim()),
        );
      expect(chips).toHaveLength(7);
      for (const c of chips)
        expect(
          STAGE_CHIP[c[0].replace(/`/g, '') as keyof typeof STAGE_CHIP],
        ).toBe(c[2]);
    });
  },
);

describe('chips (fixed text)', () => {
  it('are the exact words', () => {
    expect(STAGE_CHIP).toEqual({
      planned: 'Planned',
      ready: 'Ready',
      active: 'In progress',
      resolving: 'Checking evidence',
      resolved: 'Done',
      blocked: 'Blocked',
      skipped: 'Skipped',
    });
  });
});

const RES = { ruleIds: ['r'], criterionResults: [{}], policyVersion: 'v1' };
describe('evaluateStageTransition', () => {
  it('ST03 is refused unless the problem is active', () => {
    for (const p of ['paused', 'stuck', 'draft'] as const)
      expect(
        evaluateStageTransition({
          from: 'ready',
          to: 'active',
          actor: 'steward',
          context: { problemState: p },
        }),
      ).toMatchObject({ ok: false, code: 'condition_failed' });
    expect(
      evaluateStageTransition({
        from: 'ready',
        to: 'active',
        actor: 'steward',
        context: { problemState: 'active' },
      }).ok,
    ).toBe(true);
  });
  it('system start needs autoStart; a person cannot do ST02', () => {
    const context = { problemState: 'active' as const };
    expect(
      evaluateStageTransition({
        from: 'ready',
        to: 'active',
        actor: 'system',
        context,
      }),
    ).toMatchObject({ code: 'not_permitted' });
    expect(
      evaluateStageTransition({
        from: 'ready',
        to: 'active',
        actor: 'system',
        context: { ...context, autoStart: true },
      }).ok,
    ).toBe(true);
    expect(
      evaluateStageTransition({
        from: 'planned',
        to: 'ready',
        actor: 'steward',
        context: { predecessorsResolved: true },
      }),
    ).toMatchObject({ code: 'not_permitted' });
  });
  it('ST04 needs choice, tasks and evidence', () => {
    const all = { choiceRecorded: true, tasksDone: true, evidenceMapped: true };
    expect(
      evaluateStageTransition({
        from: 'active',
        to: 'resolving',
        actor: 'steward',
        context: all,
      }).ok,
    ).toBe(true);
    for (const k of Object.keys(all))
      expect(
        evaluateStageTransition({
          from: 'active',
          to: 'resolving',
          actor: 'steward',
          context: { ...all, [k]: false },
        }),
      ).toMatchObject({ code: 'condition_failed' });
  });
  it('ST05 needs a run id, the result fields and an active problem', () => {
    const base = { from: 'resolving', to: 'resolved', actor: 'run' } as const;
    expect(
      evaluateStageTransition({
        ...base,
        fields: RES,
        context: { problemState: 'active' },
      }),
    ).toMatchObject({ code: 'not_permitted' });
    expect(
      evaluateStageTransition({
        ...base,
        context: { runId: 'x', problemState: 'active' },
      }),
    ).toMatchObject({
      code: 'missing_fields',
      missing: ['ruleIds', 'criterionResults', 'policyVersion'],
    });
    expect(
      evaluateStageTransition({
        ...base,
        fields: RES,
        context: { runId: 'x', problemState: 'paused' },
      }),
    ).toMatchObject({ code: 'condition_failed' });
    expect(
      evaluateStageTransition({
        ...base,
        fields: RES,
        context: { runId: 'x', problemState: 'active' },
      }).ok,
    ).toBe(true);
    expect(
      evaluateStageTransition({
        ...base,
        actor: 'steward',
        fields: RES,
        context: { problemState: 'active' },
      }),
    ).toMatchObject({ code: 'not_permitted' });
  });
  it('ST08 returns to the recorded prior state only', () => {
    const fields = { clearedNote: 'n', evidence: ['u'] };
    expect(
      evaluateStageTransition({
        from: 'blocked',
        to: 'active',
        actor: 'steward',
        fields,
        context: { priorState: 'active' },
      }).ok,
    ).toBe(true);
    expect(
      evaluateStageTransition({
        from: 'blocked',
        to: 'ready',
        actor: 'steward',
        fields,
        context: { priorState: 'active' },
      }),
    ).toMatchObject({ code: 'invalid_transition' });
  });
  it('rejects pairs not in the table, including to solved states that are not stage states', () => {
    expect(
      evaluateStageTransition({
        from: 'planned',
        to: 'active',
        actor: 'steward',
      }),
    ).toMatchObject({ code: 'invalid_transition' });
    expect(
      evaluateStageTransition({
        from: 'resolved',
        to: 'ready',
        actor: 'run',
        context: { runId: 'x' },
      }),
    ).toMatchObject({ code: 'invalid_transition' });
  });
  it('ST09 and ST11 and ST10 need a reason', () => {
    const ctx = { runId: 'x' };
    expect(
      evaluateStageTransition({
        from: 'planned',
        to: 'skipped',
        actor: 'run',
        context: ctx,
      }),
    ).toMatchObject({ code: 'missing_fields' });
    expect(
      evaluateStageTransition({
        from: 'planned',
        to: 'skipped',
        actor: 'system',
        fields: { reason: 'r' },
      }).ok,
    ).toBe(true);
    expect(
      evaluateStageTransition({
        from: 'skipped',
        to: 'planned',
        actor: 'run',
        fields: { reason: 'r' },
        context: ctx,
      }).ok,
    ).toBe(true);
    expect(
      evaluateStageTransition({
        from: 'resolved',
        to: 'active',
        actor: 'run',
        fields: { reason: 'r', criteriaAffected: ['c'] },
        context: ctx,
      }).ok,
    ).toBe(true);
  });
});

describe('domain purity (lint boundary)', () => {
  it('imports nothing from Nest, Drizzle, pg or node I/O', () => {
    const dir = __dirname;
    for (const f of readdirSync(dir).filter(
      (x) => x.endsWith('.ts') && !x.endsWith('.spec.ts'),
    )) {
      const imports = [
        ...readFileSync(resolve(dir, f), 'utf8').matchAll(/from '([^']+)'/g),
      ].map((m) => m[1]);
      for (const m of imports)
        expect(m.startsWith('.'), `${f} imports ${m}`).toBe(true);
    }
  });
});
