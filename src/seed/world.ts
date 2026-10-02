import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import {
  emailBlindIndex,
  encryptEmail,
  hashSecret,
} from '../accounts/infra/crypto.js';
import { generateHandle } from '../accounts/domain/handle.js';
import { config } from '../config.js';
import { PROTOCOL_VERSION } from '../domain/protocol.js';
import * as s from '../db/schema.js';

/** Fixed ids so reseeding upserts. Ranges: 1xx accounts, 2xx jurisdictions, 3xx invites, 4xx problems, 5xx events. */
export const sid = (n: number): string =>
  `01930000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

export const SEED_IDS = {
  amsterdam: sid(0x201),
  fiktiva: sid(0x202),
  stewardOne: sid(0x101),
  memberOne: sid(0x103),
};

// Reserved example domain; never a real mailbox.
const ACCOUNTS = [
  ['steward-one', 'moderator'],
  ['steward-two', 'moderator'],
  ['member-one', 'member'],
  ['member-two', 'member'],
  ['volunteer-one', 'member'],
  ['volunteer-two', 'member'],
  ['volunteer-three', 'member'],
] as const;

/** Deterministic rng (mulberry32) so generated handles are stable too. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEV_INVITE_CODES = [1, 2, 3].map((n) => `CAN-DEV-INVITE-${n}`);

export interface SeedSummary {
  accounts: { email: string; handle: string }[];
  jurisdictions: number;
  invites: number;
}

/** Accounts, jurisdictions and invites. Publishes no problem. Safe to run twice. */
export async function seedWorld(pool: pg.Pool): Promise<SeedSummary> {
  const db = drizzle(pool, { schema: s });
  const now = new Date();
  const base = {
    originNodeId: config.nodeId,
    protocolVersion: PROTOCOL_VERSION,
  };
  const encKey = Buffer.from(config.emailEncKey, 'base64');
  const idxKey = Buffer.from(config.emailIndexKey, 'base64');
  const invKey = Buffer.from(config.inviteHashKey, 'base64');

  await db
    .insert(s.jurisdiction)
    .values([
      {
        ...base,
        id: SEED_IDS.amsterdam,
        name: 'Amsterdam (NL)',
        kind: 'city',
        isFictional: false,
        enabled: true,
        emergencyNotice:
          'If someone is in danger, contact your local emergency number.',
        ruleSetVersion: config.policyActive['default']?.version ?? 'dev',
      },
      {
        ...base,
        id: SEED_IDS.fiktiva,
        name: 'Fiktiva City',
        kind: 'city',
        isFictional: true,
        enabled: true,
        emergencyNotice:
          'If someone is in danger, contact your local emergency number.',
        ruleSetVersion: 'dev',
      },
    ])
    .onConflictDoNothing();

  const r = rng(20260101);
  const used = new Set<string>();
  const accounts: SeedSummary['accounts'] = [];
  for (const [i, [name, role]] of ACCOUNTS.entries()) {
    let handle = generateHandle(r);
    while (used.has(handle)) handle = generateHandle(r);
    used.add(handle);
    const email = `${name}@example.org`;
    accounts.push({ email, handle });
    await db
      .insert(s.account)
      .values({
        ...base,
        id: sid(0x101 + i),
        emailCiphertext: encryptEmail(email, encKey),
        emailHmac: emailBlindIndex(email, idxKey),
        handle,
        role,
        volunteerReviewer: name.startsWith('volunteer'),
        volunteerReviewerSince: name.startsWith('volunteer') ? now : null,
        ageConfirmedAt: now,
        createdAt: now,
      })
      .onConflictDoNothing();
  }

  const expiresAt = new Date(now.getTime() + 365 * 86_400_000);
  await db
    .insert(s.invite)
    .values(
      DEV_INVITE_CODES.map((code, i) => ({
        id: sid(0x301 + i),
        codeHash: hashSecret(code, invKey),
        issuedBy: SEED_IDS.stewardOne,
        expiresAt,
      })),
    )
    .onConflictDoNothing();

  return { accounts, jurisdictions: 2, invites: DEV_INVITE_CODES.length };
}

/** Everything seedWorld and the fixture write, children first. Used by --reset and tests. */
export const RESET_SQL =
  'truncate table problem_event, problem, login_code, session, invite, account, jurisdiction, audit_event, events';
