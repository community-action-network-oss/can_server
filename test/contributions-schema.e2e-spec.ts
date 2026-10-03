import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { newId } from '../src/domain/ids.js';

let pool: pg.Pool;
let c: pg.PoolClient;
let problemId: string;
let accountId: string;
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  c = await pool.connect();
  await c.query('begin');
  accountId = newId();
  await c.query(
    `insert into account (id,email_ciphertext,email_hmac,handle,created_at,origin_node_id,protocol_version)
     values ($1,'\\x00',decode($2,'hex'),$3,now(),'n','1')`,
    [accountId, accountId.replace(/-/g, ''), `h-${accountId}`],
  );
  problemId = newId();
  await c.query(
    `insert into problem (id,state,help_needed,origin_node_id,protocol_version)
     values ($1,'active','{}','n','1')`,
    [problemId],
  );
});
afterAll(async () => {
  await c.query('rollback');
  c.release();
  await pool.end();
});

const ins = async (o: {
  type?: string;
  status?: string;
  author?: string | null;
  actor?: string | null;
}) => {
  await c.query('savepoint s');
  try {
    await c.query(
      `insert into contribution (id,problem_id,author_id,system_actor,type,body,status,created_at,origin_node_id,protocol_version)
       values ($1,$2,$3,$4,$5,'{}',$6,now(),'n','1')`,
      [
        newId(),
        problemId,
        o.author === undefined ? accountId : o.author,
        o.actor ?? null,
        o.type ?? 'observation',
        o.status ?? 'pending_review',
      ],
    );
  } finally {
    // rolled back below on failure
  }
};
const fails = async (p: Promise<unknown>) => {
  await expect(p).rejects.toThrow();
  await c.query('rollback to savepoint s');
};

describe('contribution schema', () => {
  it('accepts a valid row and a labelled system actor', async () => {
    await ins({});
    await ins({ author: null, actor: 'news_watch', type: 'evidence' });
  });
  it('rejects a bad type, bad status, and bad actor combinations', async () => {
    await fails(ins({ type: 'rant' }));
    await fails(ins({ status: 'deleted' }));
    await fails(ins({ author: null }));
    await fails(ins({ actor: 'news_watch' }));
  });
  it('has no blob, file or upload column (EVID-URL-1)', async () => {
    const r = await c.query(
      `select table_name, column_name from information_schema.columns
       where table_name in ('contribution','evidence_ref') and column_name ~* 'blob|file|bytea|upload'`,
    );
    expect(r.rows).toEqual([]);
    const t = await c.query(
      `select column_name from information_schema.columns
       where table_name in ('contribution','evidence_ref') and data_type = 'bytea'`,
    );
    expect(t.rows).toEqual([]);
  });
});
