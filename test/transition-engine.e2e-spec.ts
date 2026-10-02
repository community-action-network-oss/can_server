import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import * as s from '../src/db/schema.js';
import { newId } from '../src/domain/ids.js';
import type { ActorKind } from '../src/domain/lifecycle/table.js';
import { AuditPort } from '../src/platform/audit/audit.service.js';
import { UuidV7Generator } from '../src/platform/ports.js';
import { FixedClock } from '../src/platform/testing.js';
import {
  TransitionEngine,
  type ApplyInput,
} from '../src/problems/app/transition-engine.js';
import {
  NoReviewFacts,
  NoopDecisionNotifier,
  TransitionEffects,
  type ReviewFacts,
} from '../src/problems/app/transition-ports.js';
import { ProblemFixtures } from './support/problems.js';

const now = new Date('2031-06-01T00:00:00Z');
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof s>>;
let fx: ProblemFixtures;
let effects: TransitionEffects;
let engine: TransitionEngine;
let initiator: string;
const reviewDone: ReviewFacts = {
  get: async () => ({
    atLeastOneCompletedReview: true,
    reviewQuorumMetOrPosterOverride: true,
  }),
};
const make = (review: ReviewFacts) => {
  const clock = new FixedClock(now);
  const ids = new UuidV7Generator();
  return new TransitionEngine(
    db,
    clock,
    ids,
    new AuditPort(clock, ids),
    review,
    new NoopDecisionNotifier(),
    effects,
  );
};
const row = async (id: string) =>
  (await db.select().from(s.problem).where(eq(s.problem.id, id)))[0];
const events = (id: string) =>
  db.select().from(s.problemEvent).where(eq(s.problemEvent.problemId, id));
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code as string,
  );

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  db = drizzle(pool, { schema: s });
  fx = new ProblemFixtures(db);
  effects = new TransitionEffects();
  engine = make(reviewDone);
  initiator = await fx.account();
});
afterAll(async () => {
  await fx.cleanup();
  await pool.end();
});

const T01 = {
  title: 't',
  structuralStatement: 's',
  facts: ['f'],
  affectedScope: 'a',
  coarseArea: 'c',
  sources: ['u'],
  finalAcceptanceCriteria: ['c'],
  stagePlan: {},
  noIdentifiersConfirmed: true,
  schemaVersionPin: 'v1',
};
const DEC = { ruleIds: ['R1'] };
const run = { kind: 'run' as ActorKind, id: null };
const sys = { kind: 'system' as ActorKind, id: null };
// [id, from, to, actor, fields, conditions, extra row, expected checks]
type Case = [
  string,
  string,
  string,
  'ini' | 'run' | 'sys',
  Record<string, unknown>,
  ApplyInput['conditions']?,
];
const CASES: Case[] = [
  ['T01', 'draft', 'in_review', 'ini', T01],
  [
    'T02',
    'in_review',
    'needs_revision',
    'run',
    {
      ...DEC,
      fieldRefs: ['title'],
      revisionHints: ['h'],
      appealableUntil: 'x',
    },
  ],
  [
    'T03',
    'needs_revision',
    'in_review',
    'ini',
    { changedFlaggedField: 'title' },
  ],
  ['T04', 'in_review', 'active', 'run', { ...DEC, publicationRequest: true }],
  [
    'T05',
    'in_review',
    'rejected',
    'run',
    { ...DEC, publicExplanation: 'e', appealableUntil: 'x' },
  ],
  ['T06', 'in_review', 'withdrawn', 'ini', {}],
  ['T07', 'needs_revision', 'withdrawn', 'sys', {}],
  ['T08', 'draft', 'held', 'sys', { failedRunId: 'r' }],
  ['T09', 'in_review', 'held', 'sys', { failedRunId: 'r' }],
  [
    'T11',
    'active',
    'paused',
    'ini',
    { reasonCode: 'wait', resumeCondition: 'c', reviewDate: 'd' },
  ],
  ['T12', 'paused', 'active', 'ini', { resumeConditionNote: 'n' }],
  [
    'T13',
    'active',
    'stuck',
    'run',
    {
      blockerStatement: 'b',
      blockerSource: 's',
      blockerSourceVersion: 'v',
      blockedActions: ['a'],
      recheckCondition: 'c',
      escalationRoute: 'e',
      documentedAttempt: 'd',
    },
    { noRemainingRequiredStageCanProceed: true },
  ],
  [
    'T14',
    'stuck',
    'active',
    'run',
    { blockerClearedNote: 'n', evidenceIds: ['e'] },
  ],
  [
    'T15',
    'active',
    'solved',
    'run',
    { criteriaEvidence: ['e'], outcomeStatement: 'o' },
    { everyRequiredStageResolvedOrSkipped: true },
  ],
  [
    'T16',
    'paused',
    'closed',
    'run',
    { reasonCode: 'duplicate', explanation: 'x' },
  ],
  [
    'T17',
    'stuck',
    'redirected',
    'run',
    { destination: 'd', routeText: 'r', reasonCode: 'x' },
  ],
  [
    'T18',
    'active',
    'withdrawn',
    'ini',
    {},
    { noOtherAcceptedContribution: true },
  ],
  ['T22', 'active', 'active', 'run', { planProposal: {} }],
];

describe('transition engine', () => {
  it.each(CASES)(
    '%s %s -> %s',
    async (id, from, to, who, fields, conditions) => {
      const pid = await fx.problem(from, {
        initiatorId: initiator,
        publishedAt: now,
      });
      const actor =
        who === 'ini'
          ? { kind: 'initiator' as const, id: initiator }
          : who === 'run'
            ? run
            : sys;
      const r = await engine.apply({
        problemId: pid,
        to: to as never,
        actor,
        fields,
        conditions,
        runId: who === 'run' ? newId() : undefined,
        transitionId: id,
      });
      const p = await row(pid);
      expect(p.state).toBe(to);
      expect(p.version).toBe(2);
      expect(p.pendingTransition).toBeNull();
      expect(r.version).toBe(2);
      const ev = await events(pid);
      expect(ev).toHaveLength(1);
      expect(ev[0].fromState).toBe(from);
      expect(ev[0].toState).toBe(to);
      expect(ev[0].payload).toMatchObject({ transitionId: id });
      if (id === 'T01') expect(p.reviewRequestedAt).toEqual(now);
      if (id === 'T04') expect(p.publishedAt).toEqual(now);
      if (id === 'T05')
        expect(p.purgeAfter).toEqual(new Date(now.getTime() + 30 * 86_400_000));
      if (id === 'T08') expect(p.resumeState).toBe('draft');
      if (id === 'T11')
        expect([p.resumeState, p.pauseReason]).toEqual(['active', 'wait']);
      if (id === 'T18') expect(p.tombstonedAt).toEqual(now);
      if (id === 'T22') expect(p.planVersion).toBe(2);
      if (who === 'run') {
        const a = await db
          .select()
          .from(s.auditEvent)
          .where(eq(s.auditEvent.subjectId, pid));
        expect(a).toHaveLength(1);
      }
    },
  );

  it('T10 returns a held problem to its resume state', async () => {
    const pid = await fx.problem('held', { resumeState: 'in_review' });
    await engine.apply({
      problemId: pid,
      to: 'in_review',
      actor: sys,
      fields: { completedRunId: 'r' },
    });
    const p = await row(pid);
    expect([p.state, p.resumeState]).toEqual(['in_review', null]);
  });

  it('audits transitional runs with the flag', async () => {
    const pid = await fx.problem('in_review');
    await engine.apply({
      problemId: pid,
      to: 'rejected',
      actor: run,
      runId: newId(),
      transitional: true,
      fields: { ...DEC, publicExplanation: 'e', appealableUntil: 'x' },
    });
    const [a] = await db
      .select()
      .from(s.auditEvent)
      .where(eq(s.auditEvent.subjectId, pid));
    expect(a.transitional).toBe(true);
  });

  it('refuses run-gated transitions without a run id and from a person', async () => {
    const pid = await fx.problem('in_review', { initiatorId: initiator });
    const f = { ...DEC, publicationRequest: true };
    expect(
      await code(
        engine.apply({ problemId: pid, to: 'active', actor: run, fields: f }),
      ),
    ).toBe('not_permitted');
    expect(
      await code(
        engine.apply({
          problemId: pid,
          to: 'active',
          actor: { kind: 'initiator', id: initiator },
          fields: f,
        }),
      ),
    ).toBe('not_permitted');
    expect(
      await code(
        engine.apply({
          problemId: pid,
          to: 'active',
          actor: { kind: 'lane', id: null },
          fields: f,
        }),
      ),
    ).toBe('not_permitted');
    const a = await fx.problem('active', { initiatorId: initiator });
    expect(
      await code(
        engine.apply({
          problemId: a,
          to: 'solved',
          actor: { kind: 'initiator', id: initiator },
          fields: { criteriaEvidence: ['e'], outcomeStatement: 'o' },
          conditions: { everyRequiredStageResolvedOrSkipped: true },
        }),
      ),
    ).toBe('not_permitted');
    expect((await row(pid)).state).toBe('in_review');
  });

  it('refuses another account acting as initiator', async () => {
    const pid = await fx.problem('draft', { initiatorId: initiator });
    expect(
      await code(
        engine.apply({
          problemId: pid,
          to: 'in_review',
          actor: { kind: 'initiator', id: await fx.account() },
          fields: T01,
        }),
      ),
    ).toBe('not_permitted');
  });

  it('refuses T04 without a completed review fact', async () => {
    const pid = await fx.problem('in_review');
    const e = make(new NoReviewFacts());
    expect(
      await code(
        e.apply({
          problemId: pid,
          to: 'active',
          actor: run,
          runId: newId(),
          fields: { ...DEC, publicationRequest: true },
        }),
      ),
    ).toBe('invalid_transition');
    expect((await row(pid)).state).toBe('in_review');
  });

  it('refuses T20 and T21 for now, and invalid pairs, and missing fields', async () => {
    const solved = await fx.problem('solved');
    const reopen = {
      oldPolicyVersion: 1,
      newPolicyVersion: 2,
      changedConclusion: 'c',
      changedRuleIds: ['r'],
      affectedStages: ['s'],
      feasibilityResult: 'ok',
    };
    expect(
      await code(
        engine.apply({
          problemId: solved,
          to: 'active',
          actor: run,
          runId: newId(),
          fields: reopen,
          conditions: { feasibilityPassed: true },
        }),
      ),
    ).toBe('not_permitted');
    const stuck = await fx.problem('stuck');
    expect(
      await code(
        engine.apply({
          problemId: stuck,
          to: 'active',
          actor: run,
          runId: newId(),
          transitionId: 'T20',
          fields: reopen,
          conditions: { feasibilityPassed: true },
        }),
      ),
    ).toBe('not_permitted');
    const d = await fx.problem('draft', { initiatorId: initiator });
    expect(
      await code(
        engine.apply({
          problemId: d,
          to: 'solved',
          actor: { kind: 'initiator', id: initiator },
        }),
      ),
    ).toBe('invalid_transition');
    expect(
      await code(
        engine.apply({
          problemId: d,
          to: 'in_review',
          actor: { kind: 'initiator', id: initiator },
          fields: {},
        }),
      ),
    ).toBe('validation_failed');
    expect(
      await code(engine.apply({ problemId: newId(), to: 'held', actor: sys })),
    ).toBe('not_found');
  });

  it('records a proposal, then a run decision applies it', async () => {
    const pid = await fx.problem('active', { initiatorId: initiator });
    const me = { kind: 'initiator' as const, id: initiator };
    const f = { criteriaEvidence: ['e'], outcomeStatement: 'o' };
    await engine.apply({
      problemId: pid,
      to: 'solved',
      actor: me,
      action: 'propose',
      fields: f,
    });
    let p = await row(pid);
    expect(p.state).toBe('active');
    expect(p.pendingTransition).toMatchObject({ to: 'solved' });
    expect(
      await code(
        engine.apply({
          problemId: pid,
          to: 'solved',
          actor: me,
          action: 'propose',
          fields: f,
        }),
      ),
    ).toBe('conflict');
    await engine.apply({
      problemId: pid,
      to: 'solved',
      actor: run,
      runId: newId(),
      fields: f,
      conditions: { everyRequiredStageResolvedOrSkipped: true },
    });
    p = await row(pid);
    expect([p.state, p.pendingTransition]).toEqual(['solved', null]);
    expect((await events(pid)).map((e) => e.type).sort()).toEqual([
      'solved',
      'transition_decided',
      'transition_proposed',
    ]);
  });

  it('a decline clears the proposal with the run explanation; a person cannot decline', async () => {
    const pid = await fx.problem('active', { initiatorId: initiator });
    const me = { kind: 'initiator' as const, id: initiator };
    await engine.apply({
      problemId: pid,
      to: 'closed',
      actor: me,
      action: 'propose',
      fields: { reasonCode: 'x', explanation: 'y' },
    });
    expect(
      await code(
        engine.apply({
          problemId: pid,
          to: 'closed',
          actor: me,
          action: 'decline',
        }),
      ),
    ).toBe('not_permitted');
    await engine.apply({
      problemId: pid,
      to: 'closed',
      actor: run,
      runId: newId(),
      action: 'decline',
      fields: { ruleIds: ['R9'], explanation: 'no' },
    });
    const p = await row(pid);
    expect([p.state, p.pendingTransition]).toEqual(['active', null]);
    const d = (await events(pid)).find(
      (e) => e.type === 'transition_declined',
    )!;
    expect(d.payload).toMatchObject({ ruleIds: ['R9'], explanation: 'no' });
  });

  it('a throwing effect or a failing event insert changes nothing', async () => {
    const pid = await fx.problem('in_review');
    const input = {
      problemId: pid,
      to: 'rejected' as const,
      actor: run,
      runId: newId(),
      fields: { ...DEC, publicExplanation: 'e', appealableUntil: 'x' },
    };
    const bad = {
      on: ['T05' as const],
      run: async () => {
        throw new Error('effect');
      },
    };
    effects.register(bad);
    await expect(engine.apply(input)).rejects.toThrow('effect');
    (effects as unknown as { effects: unknown[] }).effects.pop();
    let p = await row(pid);
    expect([p.state, p.version]).toEqual(['in_review', 1]);
    expect(await events(pid)).toHaveLength(0);
    // failing event insert: a reason that violates nothing, so break the insert via a bad actor id type
    await expect(
      engine.apply({ ...input, actor: { kind: 'run', id: 'not-a-uuid' } }),
    ).rejects.toBeTruthy();
    p = await row(pid);
    expect([p.state, p.version]).toEqual(['in_review', 1]);
    expect(await events(pid)).toHaveLength(0);
  });

  it('runs a registered effect inside the transaction', async () => {
    const pid = await fx.problem('in_review');
    const seen: string[] = [];
    effects.register({
      on: ['T05'],
      run: async (_tx, c) => void seen.push(`${c.transitionId}:${c.to}`),
    });
    await engine.apply({
      problemId: pid,
      to: 'rejected',
      actor: run,
      runId: newId(),
      fields: { ...DEC, publicExplanation: 'e', appealableUntil: 'x' },
    });
    (effects as unknown as { effects: unknown[] }).effects.pop();
    expect(seen).toEqual(['T05:rejected']);
  });

  it('concurrent applies on one problem: exactly one wins', async () => {
    const pid = await fx.problem('active', { initiatorId: initiator });
    const me = { kind: 'initiator' as const, id: initiator };
    const go = (to: 'paused' | 'withdrawn', fields: Record<string, unknown>) =>
      engine.apply({
        problemId: pid,
        to,
        actor: me,
        fields,
        expectedVersion: 1,
        conditions: { noOtherAcceptedContribution: true },
      });
    const r = await Promise.allSettled([
      go('paused', { reasonCode: 'a', resumeCondition: 'b', reviewDate: 'c' }),
      go('withdrawn', {}),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await row(pid)).version).toBe(2);
    expect(await events(pid)).toHaveLength(1);
  });
});
