import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATES } from '../../domain/lifecycle/vocabulary.js';
import { STAGE_STATES } from '../../stages/domain/types.js';
import { allowedTypes, isAllowed, isForLaterStage } from './allowed.js';
import { COOLDOWN, nextAllowedAt } from './cooldown.js';
import { CONTRIBUTION_TYPES, USER_TYPES } from './types.js';

const root = resolve(__dirname, '../../../..');
const brief = resolve(root, 'docs/spec/01-slice-1-brief.md');
const stages = resolve(root, 'docs/spec/01b-stages.md');
const ticks = (s: string) => [...s.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);

describe('type enum', () => {
  it('has the 16 values in brief order', () => {
    expect(CONTRIBUTION_TYPES).toHaveLength(16);
    expect(USER_TYPES).not.toContain('moderation_feedback');
    expect(USER_TYPES).toHaveLength(15);
  });
  it.skipIf(!existsSync(brief))('equals brief section 6', () => {
    const line = readFileSync(brief, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('`clarifying_question`'))!;
    expect(ticks(line)).toEqual([...CONTRIBUTION_TYPES]);
  });
});

describe('allowed matrix', () => {
  const AHEAD = [
    'clarifying_question',
    'observation',
    'evidence',
    'constraint',
    'risk',
    'stakeholder_perspective',
    'proposed_solution',
    'proposal_improvement',
    'implementation_offer',
  ];
  const stageExpected: Record<string, readonly string[]> = {
    planned: AHEAD,
    ready: AHEAD,
    active: USER_TYPES,
    resolving: ['clarifying_question', 'risk'],
    blocked: [
      'clarifying_question',
      'progress_update',
      'evidence',
      'constraint',
    ],
    resolved: [],
    skipped: [],
  };
  const problemExpected = (p: string) =>
    p === 'active'
      ? USER_TYPES
      : p === 'paused' || p === 'stuck'
        ? ['clarifying_question', 'progress_update']
        : [];

  it('covers every (problem state, stage state, type) triple', () => {
    for (const problemState of STATES)
      for (const stageState of [null, ...STAGE_STATES]) {
        const want =
          stageState === null
            ? problemExpected(problemState)
            : problemState === 'active'
              ? stageExpected[stageState]!
              : [];
        for (const type of CONTRIBUTION_TYPES)
          expect(
            isAllowed({ problemState, stageState, type }),
            `${problemState}/${stageState}/${type}`,
          ).toBe(want.includes(type));
      }
  });
  it('flags planned and ready as for-later', () => {
    expect(STAGE_STATES.filter(isForLaterStage)).toEqual(['planned', 'ready']);
    expect(isForLaterStage(null)).toBe(false);
  });
  it.skipIf(!existsSync(stages))('equals the 01b 4b.6 table', () => {
    const rows = readFileSync(stages, 'utf8')
      .split('## 4b.6')[1]!
      .split('\n')
      .filter((l) => /^\| `/.test(l));
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      const [states, types] = row.split('|').slice(1, 3) as [string, string];
      const list = /all types/.test(types)
        ? [...USER_TYPES]
        : /none/.test(types)
          ? []
          : ticks(types.replace(/\(.*\)/, '')).filter((t) =>
              (CONTRIBUTION_TYPES as readonly string[]).includes(t),
            );
      for (const st of ticks(states))
        expect(
          allowedTypes({ problemState: 'active', stageState: st as never }),
          st,
        ).toEqual(list);
    }
  });
});

describe('cooldown', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const ago = (s: number) => new Date(now.getTime() - s * 1000);
  const base = { now, lastContributionAt: null, lastRejectedAt: null };
  it('defaults live in one constant', () => {
    expect(COOLDOWN.betweenContributionsSeconds).toBe(120);
    expect(COOLDOWN.afterRejectionSeconds).toBe(600);
    expect(COOLDOWN.exemptTypes).toEqual([
      'progress_update',
      'verification_evidence',
    ]);
  });
  it('is null with no history or when elapsed', () => {
    expect(nextAllowedAt({ ...base, type: 'observation' })).toBeNull();
    expect(
      nextAllowedAt({
        ...base,
        lastContributionAt: ago(120),
        type: 'observation',
      }),
    ).toBeNull();
  });
  it('waits 2 minutes after a contribution', () => {
    expect(
      nextAllowedAt({
        ...base,
        lastContributionAt: ago(30),
        type: 'observation',
      }),
    ).toEqual(new Date(now.getTime() + 90_000));
  });
  it('waits 10 minutes after a rejection, the later bound wins', () => {
    expect(
      nextAllowedAt({
        ...base,
        lastContributionAt: ago(30),
        lastRejectedAt: ago(60),
        type: 'risk',
      }),
    ).toEqual(new Date(now.getTime() + 540_000));
  });
  it('exempts progress and verification', () => {
    for (const type of COOLDOWN.exemptTypes)
      expect(
        nextAllowedAt({
          ...base,
          lastContributionAt: ago(1),
          lastRejectedAt: ago(1),
          type,
        }),
      ).toBeNull();
  });
});
