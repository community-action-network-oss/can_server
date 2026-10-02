/**
 * Mailpit helper for e2e tests. Every e2e test that reads mail MUST call
 * clearMailbox() first, so it never sees another test's message.
 */
const BASE = process.env.MAILPIT_URL ?? 'http://localhost:8025';

export async function clearMailbox(): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/messages`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`mailpit clear failed: ${res.status}`);
}

export interface MailpitMessage {
  Subject: string;
  Text: string;
  To: { Address: string }[];
}

/** Polls up to 5 seconds for the newest message addressed to `address`. */
export async function latestMessageTo(
  address: string,
): Promise<MailpitMessage> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${BASE}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}&limit=1`,
    );
    const list = (await res.json()) as { messages: { ID: string }[] };
    if (list.messages[0]) {
      const full = await fetch(`${BASE}/api/v1/message/${list.messages[0].ID}`);
      return (await full.json()) as MailpitMessage;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no mail arrived within 5s');
}

export function extractCode(text: string): string {
  const m = /\b(\d{6})\b/.exec(text);
  if (!m) throw new Error('no 6 digit code in message');
  return m[1]!;
}
