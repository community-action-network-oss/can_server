import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { log, redact, requestLogger } from './logger.js';

describe('redact', () => {
  it('masks nested sensitive keys and arrays', () => {
    const out = JSON.stringify(
      redact({
        a: { Email: 'x@y.z', list: [{ loginCode: '123456' }, { ok: 1 }] },
        cookie: 'sid=1',
        authToken: 'tok',
        narrative: 'story',
        keep: 'fine',
      }),
    );
    for (const s of ['x@y.z', '123456', 'sid=1', 'tok', 'story'])
      expect(out).not.toContain(s);
    expect(out).toContain('fine');
  });
});

describe('log', () => {
  it('writes one redacted JSON line', () => {
    const lines: string[] = [];
    log('info', 'hi', { requestId: 'r1', email: 'a@b.c' }, (l) =>
      lines.push(l),
    );
    expect(lines).toHaveLength(1);
    const o = JSON.parse(lines[0]);
    expect(o).toMatchObject({ level: 'info', msg: 'hi', requestId: 'r1' });
    expect(lines[0]).not.toContain('a@b.c');
  });
});

describe('requestLogger', () => {
  const run = (hdr?: string) => {
    const lines: string[] = [];
    const headers: Record<string, string> = {};
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      setHeader: (k: string, v: string) => (headers[k] = v),
    });
    const req = {
      header: () => hdr,
      method: 'GET',
      baseUrl: '',
      route: { path: '/health' },
    };
    requestLogger((l) => lines.push(l))(req as never, res as never, () => {});
    res.emit('finish');
    return { lines, headers };
  };

  it('echoes an incoming request id and logs route template and status', () => {
    const { lines, headers } = run('abc-123');
    expect(headers['X-Request-Id']).toBe('abc-123');
    expect(JSON.parse(lines[0])).toMatchObject({
      requestId: 'abc-123',
      method: 'GET',
      route: '/health',
      status: 200,
    });
  });

  it('generates an id when absent or unsafe', () => {
    expect(run().headers['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(run('bad id\n').headers['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
