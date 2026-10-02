import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmtpNotification } from '../src/platform/mail/smtp.adapter.js';
import { signInCode } from '../src/platform/mail/templates.js';
import { MailSendError } from '../src/platform/ports/notification.js';
import {
  clearMailbox,
  extractCode,
  latestMessageTo,
} from './support/mailpit.js';

const smtp = new SmtpNotification('smtp://localhost:1025');
afterAll(() => smtp.close());
beforeEach(clearMailbox);

describe('mail', () => {
  it('delivers sign-in code as plain text with no URL', async () => {
    const { subject, text } = signInCode('123456');
    await smtp.send({
      to: 'a@example.org',
      subject,
      text,
      kind: 'sign_in_code',
    });
    const got = await latestMessageTo('a@example.org');
    expect(got.Subject).toBe(subject);
    expect(extractCode(got.Text)).toBe('123456');
    expect(got.Text).not.toMatch(/https?:|www\./i);
    expect(got.Text).not.toMatch(/[–—]/);
  });

  it('rejects with a typed error and never logs the recipient', async () => {
    const bad = new SmtpNotification('smtp://localhost:1');
    const out: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((s) => (out.push(String(s)), true));
    let err: unknown;
    try {
      await bad.send({
        to: 'secret@example.org',
        subject: 's',
        text: 't',
        kind: 'k',
      });
    } catch (e) {
      err = e;
    } finally {
      spy.mockRestore();
      bad.close();
    }
    expect(err).toBeInstanceOf(MailSendError);
    expect(String((err as Error).message)).not.toContain('secret@');
    expect(out.join('')).toContain('mail_send_failed');
    expect(out.join('')).not.toContain('secret@');
  });
});
