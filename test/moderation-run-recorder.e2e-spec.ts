import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import * as schema from '../src/db/schema.js';
import { newId } from '../src/domain/ids.js';
import {
  RunRecorder,
  RunRecordError,
} from '../src/moderation/app/run-recorder.js';
import {
  RunStore,
  type BeginInput,
} from '../src/moderation/infra/run-store.js';

let pool: pg.Pool;
let rec: RunRecorder;
beforeAll(() => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  rec = new RunRecorder(new RunStore(drizzle(pool, { schema })));
});
afterAll(() => pool.end());

const input = (o: Partial<BeginInput> = {}): BeginInput => ({
  targetKind: 'problem',
  targetId: newId(),
  targetVersion: 1,
  dpId: 'DP-TONE',
  mode: 'blocking',
  trigger: 'submit_gate',
  policyVersion: `p@1.0.0+${newId().slice(-12)}`,
  packHash: 'h',
  ...o,
});
const statusOf = async (id: string) =>
  (await pool.query('select status from moderation_run where id=$1', [id]))
    .rows[0].status;

describe('RunRecorder', () => {
  it('returns the same run for the same key, across blocking triggers', async () => {
    const i = input();
    const a = await rec.begin(i);
    expect(a.created).toBe(true);
    expect(a.run.status).toBe('running');
    const b = await rec.begin({ ...i, trigger: 'publish' });
    expect(b.created).toBe(false);
    expect(b.run.id).toBe(a.run.id);
    const c = await rec.begin({ ...i, trigger: 'appeal' });
    expect(c.run.id).not.toBe(a.run.id);
  });

  it('creates one row for concurrent begins', async () => {
    const i = input();
    const rs = await Promise.all(Array.from({ length: 8 }, () => rec.begin(i)));
    expect(new Set(rs.map((r) => r.run.id)).size).toBe(1);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    const n = await pool.query(
      'select count(*)::int n from moderation_run where target_id=$1',
      [i.targetId],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('returns a completed run on re-delivery', async () => {
    const i = input();
    const { run } = await rec.begin(i);
    await rec.saveStage(run.id, {
      stage: 'classify',
      output: { label: 'ok' },
      tokensIn: 5,
      tokensOut: 2,
      costMicroUsd: 7,
      promptHash: 'ph1',
    });
    const done = await rec.complete(run.id, {
      dpId: i.dpId,
      outcome: 'publish',
    });
    expect(done?.status).toBe('complete');
    const again = await rec.begin(i);
    expect(again.created).toBe(false);
    expect(again.run).toMatchObject({
      id: run.id,
      status: 'complete',
      outcome: 'publish',
    });
    const row = (
      await pool.query(
        'select tokens_in,cost_micro_usd::int c,outputs,stage_prompt_hashes from moderation_run where id=$1',
        [run.id],
      )
    ).rows[0];
    expect(row).toMatchObject({
      tokens_in: 5,
      c: 7,
      outputs: { classify: { label: 'ok' } },
      stage_prompt_hashes: { classify: 'ph1' },
    });
    expect(
      await rec.complete(run.id, { dpId: i.dpId, outcome: 'publish' }),
    ).toBeNull();
  });

  it('supersedes in-flight older runs and never completes them', async () => {
    const i = input();
    const old = await rec.begin(i);
    const next = await rec.begin({ ...i, targetVersion: 2 });
    expect(next.run.status).toBe('running');
    expect(await statusOf(old.run.id)).toBe('superseded');
    expect(
      await rec.saveStage(old.run.id, { stage: 's', output: { a: 1 } }),
    ).toBe(false);
    expect(
      await rec.complete(old.run.id, { dpId: i.dpId, outcome: 'publish' }),
    ).toBeNull();
    // a late begin for the overtaken version is born superseded
    const late = await rec.begin({
      ...i,
      targetVersion: 1,
      policyVersion: 'other@1.0.0+aaaaaaaaaaaa',
    });
    expect(late.run.status).toBe('superseded');
    // a completed older run stays complete
    const j = input();
    const o = await rec.begin(j);
    await rec.complete(o.run.id, { dpId: j.dpId, outcome: 'publish' });
    await rec.begin({ ...j, targetVersion: 2 });
    expect(await statusOf(o.run.id)).toBe('complete');
    expect(
      (await rec.supersede((await rec.begin(input())).run.id))?.status,
    ).toBe('superseded');
  });

  it('resumes a crashed run with its stored stage outputs', async () => {
    const i = input();
    const { run } = await rec.begin(i);
    expect(await rec.saveStage(run.id, { stage: 'a', output: { x: 1 } })).toBe(
      true,
    );
    expect(await rec.saveStage(run.id, { stage: 'a', output: { x: 2 } })).toBe(
      false,
    ); // repeat is a no-op
    await rec.saveStage(run.id, { stage: 'b', output: { spans: [[0, 4]] } });
    const resumed = await rec.begin(i);
    expect(resumed.created).toBe(false);
    expect(resumed.stages.map((s) => [s.stage, s.output])).toEqual([
      ['a', { x: 1 }],
      ['b', { spans: [[0, 4]] }],
    ]);
    // a failed run is retried in place, keeping its stages
    await rec.fail(run.id);
    const retry = await rec.begin(i);
    expect(retry.run).toMatchObject({ id: run.id, status: 'running' });
    expect(retry.stages).toHaveLength(2);
  });

  it('requires a closed hold reason', async () => {
    const { run } = await rec.begin(input());
    expect(() => rec.hold(run.id, 'because' as never)).toThrow(RunRecordError);
    const held = await rec.hold(run.id, 'provider_timeout');
    expect(held).toMatchObject({
      status: 'held',
      held_reason: 'provider_timeout',
      outcome: 'hold',
    });
  });

  it('rejects hold as a complete outcome and escalate outside DP-CRISIS/DP-LEGAL', async () => {
    const i = input();
    const { run } = await rec.begin(i);
    expect(() =>
      rec.complete(run.id, { dpId: i.dpId, outcome: 'hold' }),
    ).toThrow(RunRecordError);
    expect(() =>
      rec.complete(run.id, { dpId: 'DP-TONE', outcome: 'escalate_human' }),
    ).toThrow();
  });

  it('never persists raw text (canary)', async () => {
    const canary = 'CANARY my neighbour Jo Smith lives at 12 Elm Street';
    const i = input();
    const { run } = await rec.begin(i);
    expect(() =>
      rec.saveStage(run.id, { stage: 'x', output: { quote: canary } }),
    ).toThrow(RunRecordError);
    expect(() =>
      rec.saveStage(run.id, { stage: 'x', output: { [canary]: 1 } }),
    ).toThrow(RunRecordError);
    await rec.saveStage(run.id, {
      stage: 'x',
      output: { label: 'ok', spans: [[3, 9]], rule_ids: ['PRIV-1'] },
    });
    await rec.complete(run.id, {
      dpId: i.dpId,
      outcome: 'reject',
      ruleIds: ['PRIV-1'],
      fieldRef: 'title',
      revisionHint: 'Remove the address',
    });
    const dump = await pool.query(
      `select (select row_to_json(r)::text from moderation_run r where id=$1) || (select coalesce(string_agg(row_to_json(s)::text,''),'') from moderation_run_stage s where run_id=$1) as t`,
      [run.id],
    );
    expect(dump.rows[0].t).not.toMatch(/CANARY|Smith|Elm/);
  });

  it('freezes decision columns once the run leaves running', async () => {
    const i = input();
    const { run } = await rec.begin(i);
    await rec.complete(run.id, { dpId: i.dpId, outcome: 'publish' });
    await expect(
      pool.query(`update moderation_run set outcome='reject' where id=$1`, [
        run.id,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      pool.query(`update moderation_run_stage set seq=9 where run_id=$1`, [
        run.id,
      ]),
    ).resolves.toBeDefined();
  });
});
