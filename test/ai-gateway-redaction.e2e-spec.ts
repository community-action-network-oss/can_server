import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrivacyGateway } from '../src/ai-gateway/app/redaction/privacy-gateway.js';
import { TokenStore } from '../src/ai-gateway/infra/token-store.js';
import { config } from '../src/config.js';
import * as schema from '../src/db/schema.js';
import { newId } from '../src/domain/ids.js';
import { AuditPort } from '../src/platform/audit/audit.service.js';
import {
  SystemClock,
  UuidV7Generator,
  type Clock,
} from '../src/platform/ports.js';

let pool: pg.Pool;
let gw: PrivacyGateway;
let tokens: TokenStore;
let now = new Date();
const clock: Clock = { now: () => now };

beforeAll(() => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  const db = drizzle(pool, { schema });
  tokens = new TokenStore(db);
  gw = new PrivacyGateway(
    db,
    clock,
    tokens,
    new AuditPort(new SystemClock(), new UuidV7Generator()),
  );
});
afterAll(() => pool.end());

const PHONE = '020 7946 0958';
const run = () => ({
  runId: newId(),
  dpId: 'DP-NAMING',
  stage: 'classify',
  providerId: 'fake-1',
});
const count = async (sql: string, p: unknown[]) =>
  (await pool.query(sql, p)).rows[0].n as number;

describe('PrivacyGateway.prepare', () => {
  it('never lets seeded identifiers into the sanitized fields, across the fixture set', async () => {
    const cases = JSON.parse(
      readFileSync('test/fixtures/moderation/priv-gateway/cases.json', 'utf8'),
    ).positive as {
      id: string;
      fields: { fieldRef: string; text: string }[];
      seeds: string[];
    }[];
    for (const c of cases) {
      const p = await gw.prepare({
        ...run(),
        fields: c.fields.map((f) => ({ zone: 'transient_raw' as const, ...f })),
      });
      const out = JSON.stringify(p);
      for (const s of c.seeds)
        expect(out.includes(s), `${c.id}: ${s}`).toBe(false);
    }
  });

  it('returns offsets of the original and writes one audit event with no text', async () => {
    const r = run();
    const text = `Ring me on ${PHONE} please`;
    const p = await gw.prepare({
      ...r,
      fields: [{ zone: 'transient_raw', fieldRef: 'description', text }],
    });
    expect(p.fields[0]!.text).toBe('Ring me on [PHONE_1] please');
    const s = p.spans.description![0]!;
    expect(text.slice(s.start, s.end)).toBe(PHONE);
    const rows = (
      await pool.query('select * from audit_event where subject_id=$1', [
        r.runId,
      ])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('ai.gateway.call');
    expect(rows[0].detail).toEqual({
      runId: r.runId,
      dpId: 'DP-NAMING',
      stage: 'classify',
      zone: 'sanitized',
      redactionCount: 1,
      providerId: 'fake-1',
    });
    expect(JSON.stringify(rows[0])).not.toContain('7946');
  });

  it('keeps restricted evidence content out: tier and description only', async () => {
    const p = await gw.prepare({
      ...run(),
      fields: [
        {
          zone: 'restricted_evidence',
          fieldRef: 'ev1',
          tier: 'T2',
          description: 'photo of a blocked drain',
        },
      ],
    });
    expect(p.fields[0]!.text).toBe('tier T2: photo of a blocked drain');
    await expect(
      gw.prepare({
        ...run(),
        fields: [
          {
            zone: 'restricted_evidence',
            fieldRef: 'ev1',
            tier: 'T2',
            description: 'd',
            text: 'the content',
          } as never,
        ],
      }),
    ).rejects.toThrow(/zone_violation/);
    await expect(
      gw.prepare({
        ...run(),
        fields: [{ zone: 'audit', fieldRef: 'x', text: 'y' } as never],
      }),
    ).rejects.toThrow(/zone_violation/);
  });

  it('fails closed: no tokens and no audit event when redaction cannot be sure', async () => {
    const r = run();
    await expect(
      gw.prepare({
        ...r,
        fields: [
          { zone: 'transient_raw', fieldRef: 'a', text: `call ${PHONE}` },
          { zone: 'transient_raw', fieldRef: 'b', text: '这是一个测试' },
        ],
      }),
    ).rejects.toThrow(/gateway_failure/);
    expect(
      await count(
        'select count(*)::int n from audit_event where subject_id=$1',
        [r.runId],
      ),
    ).toBe(0);
    expect(
      await count(
        'select count(*)::int n from pseudonym_token where operation_id=$1',
        [r.runId],
      ),
    ).toBe(0);
  });
});

describe('token store', () => {
  it('stores originals encrypted, scoped to the operation, and re-expands only for the owner', async () => {
    const r = run();
    const other = newId();
    const p = await gw.prepare({
      ...r,
      fields: [
        {
          zone: 'transient_raw',
          fieldRef: 'a',
          text: `Mr Daniel Okafor, ${PHONE}`,
        },
      ],
    });
    const raw = (
      await pool.query(
        'select ciphertext, kind, token from pseudonym_token where operation_id=$1',
        [r.runId],
      )
    ).rows;
    expect(raw.length).toBeGreaterThanOrEqual(2);
    for (const row of raw) {
      const s = (row.ciphertext as Buffer).toString('utf8');
      expect(s).not.toContain('Okafor');
      expect(s).not.toContain('7946');
    }
    const hint = `Please remove ${p.fields[0]!.text.split(',')[0]} from the title`;
    expect(await gw.reexpand(r.runId, hint, true)).toContain(
      'Mr Daniel Okafor',
    );
    expect(await gw.reexpand(r.runId, hint, false)).toBe(hint);
    expect((await tokens.resolve(other, now)).size).toBe(0);
  });

  it('expires and purges; rows cannot be updated', async () => {
    const r = run();
    await gw.prepare({
      ...r,
      fields: [{ zone: 'transient_raw', fieldRef: 'a', text: `call ${PHONE}` }],
    });
    await expect(
      pool.query('update pseudonym_token set kind=$2 where operation_id=$1', [
        r.runId,
        'X',
      ]),
    ).rejects.toThrow(/immutable/);
    const later = new Date(now.getTime() + 61 * 60 * 1000);
    expect((await tokens.resolve(r.runId, later)).size).toBe(0); // invisible before the purge runs
    expect(await tokens.purgeExpiredTokens(later)).toBeGreaterThanOrEqual(1);
    expect(
      await count(
        'select count(*)::int n from pseudonym_token where operation_id=$1',
        [r.runId],
      ),
    ).toBe(0);
  });
});

describe('PrivacyGateway.mask (masked review view)', () => {
  it('masks without storing anything', async () => {
    const before = await count(
      'select count(*)::int n from pseudonym_token',
      [],
    );
    const m = gw.mask([
      { fieldRef: 'description', text: `Mr Daniel Okafor on ${PHONE}` },
    ]);
    expect(m.fields[0]!.text).not.toMatch(/Okafor|7946/);
    expect(m.redactionCount).toBe(2);
    expect(await count('select count(*)::int n from pseudonym_token', [])).toBe(
      before,
    );
    expect(JSON.stringify(m)).not.toContain('original');
  });
  it('throws rather than return raw text', () => {
    expect(() => gw.mask([{ fieldRef: 'a', text: '这是一个测试' }])).toThrow(
      /gateway_failure/,
    );
  });
});
