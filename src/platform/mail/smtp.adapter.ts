import { createTransport, type Transporter } from 'nodemailer';
import { log } from '../logging/logger.js';
import {
  MailSendError,
  type NotificationPort,
  type OutboundMessage,
} from '../ports/notification.js';

/** Plain text only: no html part, no tracking, no link rewriting. */
export class SmtpNotification implements NotificationPort {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from = 'CAN <no-reply@can.local>',
  ) {
    this.transport = createTransport(smtpUrl);
  }

  async send(msg: OutboundMessage): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        headers: { 'X-CAN-Kind': msg.kind },
      });
    } catch (e) {
      // Never log the address, the subject or the transport error text (it can echo the address).
      log('error', 'mail_send_failed', {
        kind: msg.kind,
        reason: e instanceof Error ? e.name : typeof e,
      });
      throw new MailSendError(msg.kind);
    }
  }

  close(): void {
    this.transport.close();
  }
}

/** For unit tests: records instead of sending. */
export class InMemoryNotification implements NotificationPort {
  readonly sent: OutboundMessage[] = [];
  send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
    return Promise.resolve();
  }
}
