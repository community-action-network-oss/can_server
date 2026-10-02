import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import * as s from '../src/db/schema.js';
import { newId } from '../src/domain/ids.js';
import { AuthService } from '../src/accounts/app/auth.service.js';
import { encryptEmail } from '../src/accounts/infra/crypto.js';
import { DrizzleUnitOfWork } from '../src/accounts/infra/unit-of-work.js';
import { AuditPort } from '../src/platform/audit/audit.service.js';
import { SmtpNotification } from '../src/platform/mail/smtp.adapter.js';
import * as t from '../src/platform/mail/templates.js';
import { UuidV7Generator } from '../src/platform/ports.js';
import { FixedClock } from '../src/platform/testing.js';
import { MailDecisionNotifier } from '../src/moderation/infra/notifier.js';
import { clearMailbox, latestMessageTo } from './support/mailpit.js';
import { ProblemFixtures } from './support/problems.js';

// IP literal: nodemailer resolves names through real DNS, which hangs offline.
const smtp = new SmtpNotification('smtp://127.0.0.1:1025');
const SECRET_TEXT = 'zzprivatebodytext';
const EMAIL = `owner-${newId()}@example.org`;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle<typeof s>>;
let fx: ProblemFixtures;
let notifier: MailDecisionNotifier;
let pid: string;

function auth(mail: SmtpNotification | { send(): Promise<void> }) {
  const clock = new FixedClock(new Date('2031-06-01T00:00:00Z'));
  const ids = new UuidV7Generator();
  const key = Buffer.from(config.emailEncKey, 'base64');
  return new AuthService(
    new DrizzleUnitOfWork(db, new AuditPort(clock, ids)),
    clock,
    ids,
    mail as never,
    { encKey: key } as never,
    undefined as never,
  );
}

async function event(problemId: string, transitionId: string) {
  await db.insert(s.problemEvent).values({
    id: newId(),
    problemId,
    type: 'state_changed',
    payload: { transitionId },
    originNodeId: config.nodeId,
    protocolVersion: '1',
    occurredAt: new Date(),
  });
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  db = drizzle(pool, { schema: s });
  fx = new ProblemFixtures(db);
  const owner = await fx.account();
  await db
    .update(s.account)
    .set({
      emailCiphertext: encryptEmail(
        EMAIL,
        Buffer.from(config.emailEncKey, 'base64'),
      ),
    })
    .where(eq(s.account.id, owner));
  pid = await fx.problem('in_review', {
    initiatorId: owner,
    title: SECRET_TEXT,
    condition: SECRET_TEXT,
    purgeAfter: new Date('2026-11-03T00:00:00Z'),
  });
  notifier = new MailDecisionNotifier(db as never, auth(smtp));
});
afterAll(async () => {
  await db
    .delete(s.moderationDecision)
    .where(eq(s.moderationDecision.targetId, pid));
  await fx.cleanup();
  smtp.close();
  await pool.end();
});
beforeEach(clearMailbox);

const link = `${config.appBaseUrl}/me/problems/`;
const cases: [string, string, RegExp][] = [
  ['T01', 'in volunteer review', /volunteer review/],
  ['T02', 'Changes are requested', /changes/],
  ['T04', 'is published', /now public/],
  ['T08', 'waiting for the check', /on hold/],
  ['T09', 'waiting for the check', /on hold/],
];

describe('decision emails', () => {
  it.each(cases)(
    '%s sends one plain email to the initiator',
    async (tid, subj, re) => {
      await event(pid, tid);
      await notifier.deliver({ problemId: pid, kind: 'applied' });
      const got = await latestMessageTo(EMAIL);
      expect(got.Subject).toContain(subj);
      expect(got.Text).toMatch(re);
      expect(got.Text).toContain(`${link}${pid}`);
      expect(got.Text).not.toContain(SECRET_TEXT);
      expect(got.Text).not.toMatch(/[–—]/);
      expect(got.To.map((x) => x.Address)).toEqual([EMAIL]);
    },
  );

  it('T05 states the exact deletion date and the appeal date', async () => {
    await db.insert(s.moderationDecision).values({
      id: newId(),
      targetType: 'problem',
      targetId: pid,
      outcome: 'rejected',
      ruleIds: ['R1'],
      fieldRef: 'title',
      revisionHint: 'h',
      policyVersion: '1.0.0',
      publicExplanation: 'e',
      appealableUntil: new Date('2026-10-20T10:00:00Z'),
    });
    await event(pid, 'T05');
    await notifier.deliver({ problemId: pid, kind: 'applied' });
    const got = await latestMessageTo(EMAIL);
    expect(got.Text).toContain('Your text is deleted on 2026-11-03.');
    expect(got.Text).toContain('appeal until 2026-10-20');
    expect(got.Text).not.toContain(SECRET_TEXT);
  });

  it('sends the policy and reminder templates through sendTo', async () => {
    const l = `${link}${pid}`;
    await notifier.sendTo(
      pid,
      'x',
      t.reReviewed({ link: l, policyVersion: '2.1.0' }),
    );
    const got = await latestMessageTo(EMAIL);
    expect(got.Text).toContain('policy version 2.1.0');
    expect(got.Text).toContain('Nothing was removed silently');
    expect(got.Text).toContain('appeal');
  });

  it('proposals, declines and unmapped transitions send nothing', async () => {
    await event(pid, 'T11');
    await notifier.deliver({ problemId: pid, kind: 'applied' });
    await notifier.deliver({ problemId: pid, kind: 'proposed' });
    await expect(latestMessageTo(EMAIL)).rejects.toThrow();
  }, 10_000);

  it('a mail failure does not throw and logs no address', async () => {
    const bad = new SmtpNotification('smtp://127.0.0.1:1');
    const n = new MailDecisionNotifier(db as never, auth(bad));
    await event(pid, 'T04');
    await expect(
      n.deliver({ problemId: pid, kind: 'applied' }),
    ).resolves.toBeUndefined();
    bad.close();
  });
});

describe('templates', () => {
  it('have no dashes and no tracking', () => {
    const l = 'http://x/me/problems/1';
    const d = new Date('2026-11-03T00:00:00Z');
    for (const r of [
      t.inReview({ link: l }),
      t.appealOutcome({ link: l, outcome: 'overturned' }),
      t.revisionReminder({ link: l, withdrawOn: d }),
      t.reopened({ link: l, policyVersion: '1' }),
    ]) {
      expect(r.subject + r.text).not.toMatch(/[–—]/);
      expect(r.text.match(/https?:/g)).toHaveLength(1);
    }
    expect(t.revisionReminder({ link: l, withdrawOn: d }).text).toContain(
      '2026-11-03',
    );
  });
});
