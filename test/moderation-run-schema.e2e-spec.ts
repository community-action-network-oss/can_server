import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { newId } from '../src/domain/ids.js';

let pool: pg.Pool;
let c: pg.PoolClient;
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  c = await pool.connect();
  await c.query('begin');
});
afterAll(async () => {
  await c.query('rollback');
  c.release();
  await pool.end();
});

const run = {
  id: () => newId(),
  target_id: () => newId(),
  target_version: 1,
  dp_id: 'DP-TONE',
  outcome: 'publish',
  rule_ids: '{}',
  status: 'complete',
  held_reason: null as string | null,
  shadow: false,
  trigger: 'submit_gate',
  policy_version: 'p@1.0.0+aaaaaaaaaaaa',
};
type Run = Omit<typeof run, 'id' | 'target_id'> & {
  id?: string;
  target_id?: string;
};
const insRun = (o: Partial<Run> = {}) => {
  const r = { ...run, id: run.id(), target_id: run.target_id(), ...o };
  return c.query(
    `insert into moderation_run (id,target_kind,target_id,target_version,dp_id,mode,trigger,policy_version,pack_hash,outcome,rule_ids,status,held_reason,shadow)
     values ($1,'problem',$2,$3,$4,'blocking',$5,$6,'h',$7,$8,$9,$10,$11) returning id`,
    [
      r.id,
      r.target_id,
      r.target_version,
      r.dp_id,
      r.trigger,
      r.policy_version,
      r.outcome,
      r.rule_ids,
      r.status,
      r.held_reason,
      r.shadow,
    ],
  );
};
const fails = async (q: () => Promise<unknown>, re: RegExp) => {
  await c.query('savepoint s');
  await expect(q()).rejects.toThrow(re);
  await c.query('rollback to s');
};

describe('moderation_run constraints', () => {
  it('accepts a complete run', async () => {
    await insRun();
  });
  it('rejects a bad outcome, dp and trigger', async () => {
    await fails(() => insRun({ outcome: 'published' }), /outcome_chk/);
    await fails(() => insRun({ dp_id: 'DP-STAGE' }), /dp_chk/);
    await fails(() => insRun({ trigger: 'pre_publication' }), /trigger_chk/);
  });
  it('limits escalate_human to DP-CRISIS and DP-LEGAL', async () => {
    await fails(
      () => insRun({ outcome: 'escalate_human', dp_id: 'DP-TONE' }),
      /escalate_chk/,
    );
    await insRun({ outcome: 'escalate_human', dp_id: 'DP-CRISIS' });
    await insRun({ outcome: 'escalate_human', dp_id: 'DP-LEGAL' });
  });
  it('requires rule_ids on reject and needs_revision', async () => {
    await fails(() => insRun({ outcome: 'reject' }), /rule_ids_chk/);
    await fails(() => insRun({ outcome: 'needs_revision' }), /rule_ids_chk/);
    await insRun({ outcome: 'reject', rule_ids: '{TONE-1}' });
  });
  it('requires a closed hold reason on held runs', async () => {
    await fails(() => insRun({ status: 'held', outcome: 'hold' }), /held_chk/);
    await fails(
      () => insRun({ status: 'held', outcome: 'hold', held_reason: 'because' }),
      /held_chk/,
    );
    await insRun({
      status: 'held',
      outcome: 'hold',
      held_reason: 'provider_timeout',
    });
  });
  it('rejects a duplicate run key unless shadow', async () => {
    const k = { target_id: newId(), policy_version: 'dup@1.0.0+bbbbbbbbbbbb' };
    await insRun(k);
    await fails(() => insRun(k), /moderation_run_key_uq/);
    await insRun({ ...k, shadow: true });
  });
  it('allows only status and held_reason updates, never delete, for can_app_rw', async () => {
    const id = newId();
    await insRun({ id });
    await c.query('set local role can_app_rw');
    await c.query(`update moderation_run set status='superseded' where id=$1`, [
      id,
    ]);
    await fails(
      () =>
        c.query(`update moderation_run set outcome='reject' where id=$1`, [id]),
      /permission denied/,
    );
    await fails(
      () => c.query(`delete from moderation_run where id=$1`, [id]),
      /permission denied/,
    );
    await c.query('reset role');
  });
});

describe('moderation_decision AI columns', () => {
  const insDec = (
    outcome: string,
    runId: string | null,
    dp: string | null = null,
  ) =>
    c.query(
      `insert into moderation_decision (id,target_type,target_id,outcome,rule_ids,field_ref,revision_hint,policy_version,public_explanation,appealable_until,run_id,dp_id)
       values ($1,'problem',$2,$3,'{R-1}','title','h','v','why',now(),$4,$5)`,
      [newId(), newId(), outcome, runId, dp],
    );
  it('needs a run_id for AI outcomes, not for legacy ones', async () => {
    await fails(() => insDec('reject', null), /run_chk/);
    await insDec('rejected', null);
    const { rows } = await insRun({ outcome: 'reject', rule_ids: '{R-1}' });
    await insDec('reject', rows[0].id);
  });
  it('keeps escalate_human to DP-CRISIS and DP-LEGAL', async () => {
    const { rows } = await insRun({
      outcome: 'escalate_human',
      dp_id: 'DP-LEGAL',
    });
    await fails(
      () => insDec('escalate_human', rows[0].id, 'DP-TONE'),
      /escalate_chk/,
    );
    await insDec('escalate_human', rows[0].id, 'DP-LEGAL');
  });
  it('still requires field_ref for reject (MOD-EXPLAIN-1)', async () => {
    const { rows } = await insRun({ outcome: 'reject', rule_ids: '{R-1}' });
    await fails(
      () =>
        c.query(
          `insert into moderation_decision (id,target_type,target_id,outcome,rule_ids,policy_version,public_explanation,appealable_until,run_id)
           values ($1,'problem',$2,'reject','{R-1}','v','why',now(),$3)`,
          [newId(), newId(), rows[0].id],
        ),
      /explain_chk/,
    );
  });
});
