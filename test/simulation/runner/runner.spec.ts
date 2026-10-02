import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guard, personaEnv, run } from './runner.ts';

let srv: Server;
let url: string;
let simulation = false;
beforeAll(async () => {
  srv = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/v1/health' ? JSON.stringify({ simulation }) : '[]');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
});
afterAll(() => srv.close());

const opts = (outDir: string, allowCiStack: boolean) => ({
  scenarios: 'smoke', seed: 7, mode: 'deterministic' as const, baseUrl: url,
  outDir, pack: 'p@1', allowCiStack, newRunId: () => 'run-1',
});

describe('harness runner', () => {
  it('writes a complete run directory against a stub', async () => {
    const out = mkdtempSync(join(tmpdir(), 'sim-'));
    const dir = await run(opts(out, true));
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(m).toMatchObject({ run_id: 'run-1', seed: 7, mode: 'deterministic', pack: 'p@1' });
    expect(m.ended_at).not.toBeNull();
    const ev = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ persona: 'noop', step: 'list-problems', method: 'GET', status: 200 });
    expect(existsSync(join(dir, 'transcripts'))).toBe(true);
  });

  it('refuses a stack not marked simulation, accepts one that is', async () => {
    simulation = false;
    await expect(guard(url, false)).rejects.toThrow(/not marked/);
    simulation = true;
    await expect(guard(url, false)).resolves.toBeUndefined();
  });

  it('allow-ci-stack needs localhost', async () => {
    await expect(guard('http://example.com', true)).rejects.toThrow(/localhost/);
  });

  it('persona env carries no server secrets', () => {
    const env = personaEnv({ DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'x', SMTP_HOST: 'x', SIM_TOKEN_A: 't' });
    expect(Object.keys(env)).toEqual(['SIM_TOKEN_A']);
  });
});
