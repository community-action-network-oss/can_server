export interface OutboundMessage {
  to: string;
  subject: string;
  text: string;
  /** Template family, e.g. "sign_in_code". Never carries user data. */
  kind: string;
}

export interface NotificationPort {
  send(msg: OutboundMessage): Promise<void>;
}

export const NOTIFICATION = Symbol('NotificationPort');

/** Rejection type for any send failure. Message is fixed: no recipient, no transport detail. */
export class MailSendError extends Error {
  constructor(readonly kind: string) {
    super('Mail could not be sent');
    this.name = 'MailSendError';
  }
}
