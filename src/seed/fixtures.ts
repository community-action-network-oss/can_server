import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { config } from '../config.js';
import { PROTOCOL_VERSION } from '../domain/protocol.js';
import * as s from '../db/schema.js';
import { SEED_IDS, sid } from './world.js';

const EVIDENCE = (n: number) => `https://evidence.sim.test/fixture/${n}`;
const HELP = {
  skill_groups: [],
  languages: ['en'],
  coarse_place: 'Amsterdam',
  topics: [],
};

type St = 'active' | 'stuck' | 'solved' | 'withdrawn' | 'draft' | 'in_review';
interface F {
  n: number;
  title: string;
  state: St;
  /** Published at; null for private rows. */
  at: string | null;
  tomb?: boolean;
  initiator?: boolean;
  events: [
    type: string,
    to: St,
    reason: string,
    at: string,
    payload?: Record<string, unknown>,
  ][];
}

// Office-and-jurisdiction phrasing only; no person is named and no text implies a person decided.
const FIXTURE: F[] = [
  {
    n: 1,
    title: 'Fictional example: staged plan in progress',
    state: 'active',
    at: '2026-03-01T09:00:00Z',
    events: [
      [
        'published',
        'active',
        'Published after volunteer review.',
        '2026-03-01T09:00:00Z',
      ],
    ],
  },
  {
    n: 2,
    title: 'Fictional example: plain plan at its first stage',
    state: 'active',
    at: '2026-03-02T09:00:00Z',
    events: [
      [
        'published',
        'active',
        'Published after volunteer review.',
        '2026-03-02T09:00:00Z',
      ],
    ],
  },
  {
    n: 3,
    title: 'Fictional example: waiting on a municipal reply',
    state: 'stuck',
    at: '2026-03-03T09:00:00Z',
    events: [
      [
        'published',
        'active',
        'Published after volunteer review.',
        '2026-03-03T09:00:00Z',
      ],
      [
        'state_changed',
        'stuck',
        'No reply from the municipal office within the agreed time.',
        '2026-03-10T09:00:00Z',
      ],
    ],
  },
  {
    n: 4,
    title: 'Fictional example: solved criteria met',
    state: 'solved',
    at: '2026-03-04T09:00:00Z',
    events: [
      [
        'published',
        'active',
        'Published after volunteer review.',
        '2026-03-04T09:00:00Z',
      ],
      [
        'state_changed',
        'solved',
        'Solved criteria were met.',
        '2026-03-12T09:00:00Z',
        { policy_version: 'fixture-1', transitional: true },
      ],
    ],
  },
  {
    n: 5,
    title: 'Fictional example: withdrawn after publication',
    state: 'withdrawn',
    at: '2026-03-05T09:00:00Z',
    tomb: true,
    events: [
      [
        'published',
        'active',
        'Published after volunteer review.',
        '2026-03-05T09:00:00Z',
      ],
      [
        'tombstoned',
        'withdrawn',
        'Withdrawn after publication.',
        '2026-03-06T09:00:00Z',
      ],
    ],
  },
  {
    n: 6,
    title: 'Fictional example: never-published draft',
    state: 'draft',
    at: null,
    initiator: true,
    events: [],
  },
  {
    n: 7,
    title: 'Fictional example: waiting in review',
    state: 'in_review',
    at: null,
    initiator: true,
    events: [],
  },
];

export const FIXTURE_PROBLEM_IDS = FIXTURE.map((f) => sid(0x400 + f.n));
export const FIXTURE_PUBLIC_IDS = FIXTURE.filter((f) => f.at).map((f) =>
  sid(0x400 + f.n),
);

/** Fixture problems for unit tests and UI work. is_seed and synthetic_evidence keep them off real surfaces. Idempotent. */
export async function seedFictionalFixture(pool: pg.Pool): Promise<number> {
  const db = drizzle(pool, { schema: s });
  const base = {
    originNodeId: config.nodeId,
    protocolVersion: PROTOCOL_VERSION,
  };
  for (const f of FIXTURE) {
    const id = sid(0x400 + f.n);
    await db
      .insert(s.problem)
      .values({
        ...base,
        id,
        initiatorId: f.initiator ? SEED_IDS.memberOne : null,
        jurisdictionId: SEED_IDS.amsterdam,
        state: f.state,
        title: f.title,
        condition:
          'A shared condition in the city centre, written for testing the screens.',
        affected: 'People who live or work nearby.',
        coarseArea: 'Amsterdam city centre',
        desiredOutcome:
          'The condition is resolved and the office reports back publicly.',
        observed: `Synthetic evidence: ${EVIDENCE(f.n)}`,
        publishedAt: f.at ? new Date(f.at) : null,
        tombstonedAt: f.tomb ? new Date('2026-03-06T09:00:00Z') : null,
        withdrawnPublished: !!f.tomb,
        isSeed: true,
        syntheticEvidence: true,
        helpNeeded: HELP,
      })
      .onConflictDoNothing();
    for (const [i, [type, to, reason, at, payload]] of f.events.entries()) {
      await db
        .insert(s.problemEvent)
        .values({
          ...base,
          id: sid(0x500 + f.n * 10 + i),
          problemId: id,
          type,
          actorId: null,
          fromState: i === 0 ? 'in_review' : 'active',
          toState: to,
          reason,
          payload: payload ?? null,
          occurredAt: new Date(at),
        })
        .onConflictDoNothing();
    }
  }
  return FIXTURE.length;
}
