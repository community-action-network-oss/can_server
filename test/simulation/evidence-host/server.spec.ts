import { afterAll, beforeAll, expect, it } from 'vitest';
import dns from 'node:dns';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  buildEvidenceMetadata,
  makeHandler,
  startEvidenceHost,
  type SeedLike,
} from './server.ts';

const seeds: SeedLike[] = [
  {
    id: 'seed-1',
    evidence: [
      {
        id: 'e1',
        url: 'https://evidence.sim.test/seed-1/e1',
        description: 'Incident <summary>',
        tier_cap: 'C',
        synthetic: true,
      },
      {
        id: 'e2',
        url: 'https://evidence.sim.test/seed-1/e2',
        description: 'Second',
        tier_cap: 'B',
        synthetic: true,
      },
    ],
  },
  {
    id: 'seed-2',
    evidence: [
      {
        id: 'e1',
        url: 'https://evidence.sim.test/seed-2/e1',
        description: 'Other',
        tier_cap: 'C',
        synthetic: true,
      },
    ],
  },
];

let srv: Server;
let base: string;
beforeAll(async () => {
  srv = await startEvidenceHost(seeds);
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

it('serves every evidence item with the banner and metadata', async () => {
  for (const s of seeds)
    for (const e of s.evidence) {
      const p = new URL(e.url).pathname;
      const page = await fetch(base + p);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(
        'Synthetic evidence for a seed problem. Not real data.',
      );
      const meta = await (await fetch(`${base}${p}.json`)).json();
      expect(meta).toEqual(buildEvidenceMetadata(seeds)[e.url]);
      expect(meta.synthetic).toBe(true);
    }
});

it('escapes description, 404s unknown paths, sets no CORS header', async () => {
  expect(await (await fetch(`${base}/seed-1/e1`)).text()).toContain(
    '&#60;summary&#62;',
  );
  const miss = await fetch(`${base}/nope/x`);
  expect(miss.status).toBe(404);
  const ok = await fetch(`${base}/seed-1/e1`);
  expect(ok.headers.get('access-control-allow-origin')).toBeNull();
});

it('binds localhost only', () => {
  expect((srv.address() as AddressInfo).address).toBe('127.0.0.1');
});

it('makes no outbound connection while handling requests', () => {
  const orig = [net.Socket.prototype.connect, dns.lookup] as const;
  let calls = 0;
  net.Socket.prototype.connect = (() => {
    calls++;
    throw new Error('blocked');
  }) as never;
  (dns as { lookup: unknown }).lookup = () => {
    calls++;
    throw new Error('blocked');
  };
  try {
    const h = makeHandler(seeds);
    const res = { writeHead: () => res, end: () => res };
    h({ url: '/seed-1/e1', method: 'GET' } as never, res as never);
    h({ url: '/seed-1/e1.json', method: 'GET' } as never, res as never);
    h({ url: '/x', method: 'GET' } as never, res as never);
  } finally {
    net.Socket.prototype.connect = orig[0];
    (dns as { lookup: unknown }).lookup = orig[1];
  }
  expect(calls).toBe(0);
});
