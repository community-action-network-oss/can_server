import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { config } from '../config.js';
import * as s from '../db/schema.js';
import { PROTOCOL_VERSION } from '../domain/protocol.js';
import { planFromWire, type PlanDraft } from '../stages/app/plan-wire.js';
import { CLASSIC_5, ONE_STAGE } from '../stages/domain/templates.js';
import type { StageState } from '../stages/domain/types.js';
import { FIXTURE_PROBLEM_IDS } from './fixtures.js';
import { SEED_IDS } from './world.js';

/** A uuid-shaped id that depends only on its inputs, so reseeding hits the same rows. */
const det = (...k: string[]) => {
  const h = createHash('sha256').update(k.join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const AT = new Date('2026-03-01T10:00:00Z');
const LABEL = 'Fictional example';

const node = (
  name: string,
  label: string,
  goal: string,
  criterion: string,
  depends_on: string[] = [],
) => ({
  name,
  label,
  goal,
  acceptance_criteria: [{ statement: criterion, measure: 'met_or_not' }],
  depends_on,
});
const finals = [
  {
    statement:
      'The condition is resolved and the office reports back publicly.',
    how_observed: 'The office posts a public reply.',
  },
];

interface Spec {
  plan: PlanDraft;
  states: Record<string, StageState>;
  /** Slug of a planned stage that keeps an accepted contribution made ahead. */
  ahead?: string;
}

// One spec per fixture problem, in the order of FIXTURE_PROBLEM_IDS. Stages are fictional and name no person.
const SPECS: (Spec | null)[] = [
  {
    plan: planFromWire(
      [
        node('survey', 'Survey', 'Record what is wrong.', 'A survey is posted'),
        node(
          'repair',
          'Repair',
          'Fix what the survey found.',
          'The repair is reported done',
          ['survey'],
        ),
        node(
          'check',
          'Check',
          'Check the repair held.',
          'No new reports for 30 days',
          ['repair'],
        ),
      ],
      finals,
    ),
    states: { survey: 'resolved', repair: 'active', check: 'planned' },
    ahead: 'check',
  },
  { plan: CLASSIC_5 as PlanDraft, states: { facts: 'active' } },
  {
    plan: planFromWire(
      [
        node('notice', 'Public notice', 'Post a notice.', 'The notice is up'),
        node(
          'reply',
          'Office reply',
          'Get a reply from the office.',
          'A written reply is on file',
        ),
        node(
          'act',
          'Act on the reply',
          'Do what the reply allows.',
          'The agreed work is done',
          ['notice', 'reply'],
        ),
      ],
      finals,
    ),
    states: { notice: 'resolved', reply: 'blocked', act: 'planned' },
  },
  {
    plan: ONE_STAGE(CLASSIC_5.finalCriteria) as PlanDraft,
    states: { resolve: 'resolved' },
  },
];

/**
 * Stage rows, edges, criteria, events, evidence and one contribution kept ahead for the fictional problems (12-u10).
 * Ids are derived from the problem id, so a second run changes nothing. Idempotent. Returns the stage count.
 */
export async function seedStageFixture(
  pool: pg.Pool,
  o: { problemIds?: string[]; authorId?: string } = {},
): Promise<number> {
  const db = drizzle(pool, { schema: s });
  const authorId = o.authorId ?? SEED_IDS.memberOne;
  const base = {
    originNodeId: config.nodeId,
    protocolVersion: PROTOCOL_VERSION,
  };
  let n = 0;
  for (const [i, pid] of (o.problemIds ?? FIXTURE_PROBLEM_IDS).entries()) {
    const spec = SPECS[i];
    if (!spec) continue;
    const sId = (slug: string) => det(pid, 'stage', slug);
    const cId = (slug: string, k: number) => det(pid, 'crit', slug, String(k));
    await db
      .insert(s.stage)
      .values(
        spec.plan.stages.map((st, ordinal) => ({
          ...base,
          id: sId(st.id),
          problemId: pid,
          name: st.id,
          label: st.name,
          goal: `${LABEL}: ${st.goal}`,
          state: spec.states[st.id] ?? 'planned',
          resumeState: spec.states[st.id] === 'blocked' ? 'active' : null,
          decisionMethod: st.decisionMethod,
          required: st.required,
          needsChoice: st.needsChoice,
          autoStart: st.autoStart,
          ordinal,
        })),
      )
      .onConflictDoNothing();
    const edges = spec.plan.stages.flatMap((st) =>
      st.dependsOn.map((d) => ({ stageId: sId(st.id), dependsOnId: sId(d) })),
    );
    if (edges.length)
      await db.insert(s.stageEdge).values(edges).onConflictDoNothing();
    await db
      .insert(s.acceptanceCriterion)
      .values([
        ...spec.plan.finalCriteria.map((c, k) => ({
          id: cId('final', k),
          problemId: pid,
          stageId: null,
          statement: c.statement,
          measure: c.measure,
          ordinal: k,
        })),
        ...spec.plan.stages.flatMap((st) =>
          st.criteria.map((c, k) => ({
            id: cId(st.id, k),
            problemId: null,
            stageId: sId(st.id),
            statement: c.statement,
            measure: c.measure,
            ordinal: k,
          })),
        ),
      ])
      .onConflictDoNothing();
    for (const st of spec.plan.stages) {
      const state = spec.states[st.id] ?? 'planned';
      await db
        .insert(s.stageEvent)
        .values({
          ...base,
          id: det(pid, 'event', st.id),
          stageId: sId(st.id),
          problemId: pid,
          type: 'fixture_state',
          actorId: null,
          toState: state,
          reason: LABEL,
          payload: { label: LABEL },
          occurredAt: AT,
        })
        .onConflictDoNothing();
      if (state === 'resolved')
        await db
          .insert(s.stageEvidence)
          .values({
            id: det(pid, 'evidence', st.id),
            stageId: sId(st.id),
            url: `https://evidence.sim.test/fixture/${st.id}`,
            claimText: `${LABEL}: the criterion is met.`,
            criteriaIds: st.criteria.map((_, k) => cId(st.id, k)),
            submittedBy: authorId,
            content: { fixture: LABEL },
            createdAt: AT,
            frozenAt: AT,
          })
          .onConflictDoNothing();
      n++;
    }
    if (spec.ahead)
      await db
        .insert(s.contribution)
        .values({
          ...base,
          id: det(pid, 'ahead', spec.ahead),
          problemId: pid,
          stageId: sId(spec.ahead),
          forLaterStage: true,
          authorId,
          type: 'observation',
          body: { claim: `${LABEL}: kept ahead for the later stage.` },
          status: 'accepted',
          createdAt: AT,
          reviewedAt: AT,
        })
        .onConflictDoNothing();
  }
  return n;
}
