import { createHash } from 'node:crypto';
import type { RunStore } from '../store/store.ts';

export interface Reply {
  status: number;
  body: unknown;
  headers: Headers;
}

/** The only way a persona touches the server: plain HTTP, every exchange recorded. */
export class ApiClient {
  step = 'init';
  constructor(
    private baseUrl: string,
    private persona: string,
    private store: RunStore,
    private token?: string,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<Reply> {
    const t0 = Date.now();
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        'content-type': 'application/json',
        'x-can-client': 'native',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    this.store.event({
      persona: this.persona,
      step: this.step,
      method,
      path,
      status: res.status,
      body_sha256: createHash('sha256').update(text).digest('hex'),
      ms: Date.now() - t0,
    });
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // non-JSON body stays text
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }
}
