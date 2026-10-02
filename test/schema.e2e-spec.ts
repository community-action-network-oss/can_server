import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { AuditPort } from '../src/platform/audit/audit.service.js';
import { SystemClock, UuidV7Generator } from '../src/platform/ports.js';

const id = () => new UuidV7Generator().next();
let pool: pg.Pool;
let c: pg.PoolClient;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  c = await pool.connect();
});
afterAll(async () => {
  c.release();
  await pool.end();
});

const jur = (fict: boolean) =>
  c.query(
    `insert into jurisdiction (id,name,kind,is_fictional,origin_node_id,protocol_version) values ($1,'t','city',$2,'n','0.1.0') returning enabled`,
    [id(), fict],
  );

describe('accounts, audit and jurisdiction schema', () => {
  it('jurisdiction accepts both is_fictional values and defaults enabled=false', async () => {
    for (const f of [true, false]) {
      expect((await jur(f)).rows[0].enabled).toBe(false);
    }
  });

  it('account stores email only as ciphertext and hmac', async () => {
    const r = await c.query(
      `select column_name from information_schema.columns where table_schema='public' and column_name ilike '%email%'`,
    );
    const cols = r.rows.map((x) => x.column_name).sort();
    expect(cols).toEqual(['email_ciphertext', 'email_hmac']);
  });

  it('DECENT-1 columns exist', async () => {
    const r = await c.query(
      `select table_name, column_name from information_schema.columns where table_schema='public' and column_name in ('origin_node_id','protocol_version','prev_hash')`,
    );
    const has = (t: string, col: string) =>
      r.rows.some((x) => x.table_name === t && x.column_name === col);
    for (const t of ['account', 'jurisdiction', 'audit_event']) {
      expect(has(t, 'origin_node_id')).toBe(true);
      expect(has(t, 'protocol_version')).toBe(true);
    }
    expect(has('audit_event', 'prev_hash')).toBe(true);
  });

  it('can_app_rw is insert-only on events and audit_event', async () => {
    const aid = id();
    await c.query('begin');
    try {
      await c.query('set local role can_app_rw');
      const ins = (action: string) =>
        c.query(
          `insert into audit_event (id,action,subject_type,detail,at,origin_node_id,protocol_version) values ($1,$2,'t','{}',now(),'n','0.1.0')`,
          [aid, action],
        );
      await ins('a');
      for (const sql of [
        `update audit_event set action='x'`,
        `delete from audit_event`,
        `update events set actor='x'`,
        `delete from events`,
      ]) {
        await c.query('savepoint s');
        await expect(c.query(sql)).rejects.toThrow(/permission denied/);
        await c.query('rollback to s');
      }
      // ordinary tables stay writable
      await c.query(`delete from jurisdiction where name='t'`);
    } finally {
      await c.query('rollback');
    }
  });

  it('AuditPort rejects secret-like keys at any depth and writes clean rows', async () => {
    const port = new AuditPort(new SystemClock(), new UuidV7Generator());
    const tx = { insert: () => ({ values: async () => undefined }) } as never;
    await expect(
      port.record(tx, {
        action: 'a',
        subjectType: 't',
        detail: { email: 'x' },
      }),
    ).rejects.toThrow(/secret key/);
    await expect(
      port.record(tx, {
        action: 'a',
        subjectType: 't',
        detail: { a: [{ login_code: 1 }] },
      }),
    ).rejects.toThrow(/secret key/);
    await c.query('begin');
    try {
      const { drizzle } = await import('drizzle-orm/node-postgres');
      const db = drizzle(c);
      const rid = await port.record(db as never, {
        action: 'a',
        subjectType: 't',
        detail: { n: 1 },
      });
      const r = await c.query(
        'select protocol_version from audit_event where id=$1',
        [rid],
      );
      expect(r.rows).toHaveLength(1);
    } finally {
      await c.query('rollback');
    }
  });
});
