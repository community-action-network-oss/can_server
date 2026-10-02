import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

export type SeedEvidence = {
  id: string;
  url: string;
  description: string;
  tier_cap: string;
  synthetic: true;
};
export type SeedLike = { id: string; evidence: SeedEvidence[] };
export type EvidenceMeta = {
  publisher_role: string;
  date: string;
  kind: string;
  tier_cap: string;
  synthetic: true;
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// ponytail: publisher_role, date and kind are not in the seed format yet; fixed synthetic values until 11-u01 adds them.
export const buildEvidenceMetadata = (
  seeds: SeedLike[],
): Record<string, EvidenceMeta> =>
  Object.fromEntries(
    seeds.flatMap((s) =>
      s.evidence.map((e) => [
        e.url,
        {
          publisher_role: 'synthetic-publisher',
          date: '2026-01-01',
          kind: 'document',
          tier_cap: e.tier_cap,
          synthetic: true as const,
        },
      ]),
    ),
  );

export const writeEvidenceMetadata = (
  seeds: SeedLike[],
  outPath: string,
): void =>
  writeFileSync(
    outPath,
    JSON.stringify(buildEvidenceMetadata(seeds), null, 2) + '\n',
  );

/**
 * Pages are keyed by URL pathname only: the host (evidence.sim.test) is a reserved name the
 * server's evidence check accepts (no IP literal, no xn--, https). Humans map it with a hosts
 * entry or just open http://localhost:<port>/<seed>/<id>.
 */
export const makeHandler = (seeds: SeedLike[]) => {
  const pages = new Map<string, SeedEvidence>();
  for (const s of seeds)
    for (const e of s.evidence) pages.set(new URL(e.url).pathname, e);
  return (req: IncomingMessage, res: ServerResponse): void => {
    // No CORS headers on purpose: same-origin only.
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const isJson = path.endsWith('.json');
    const item =
      req.method === 'GET'
        ? pages.get(isJson ? path.slice(0, -5) : path)
        : undefined;
    if (!item) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    } else if (isJson) {
      const meta = buildEvidenceMetadata([{ id: '', evidence: [item] }])[
        item.url
      ];
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(meta));
    } else {
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          `<!doctype html><meta charset="utf-8"><title>Synthetic evidence</title>` +
            `<p><strong>Synthetic evidence for a seed problem. Not real data.</strong></p><p>${esc(item.description)}</p>`,
        );
    }
  };
};

/** Binds 127.0.0.1 only. port 0 picks a free port. Caller closes it. */
export const startEvidenceHost = (
  seeds: SeedLike[],
  port = 0,
): Promise<Server> =>
  new Promise((resolve, reject) => {
    const srv = createServer(makeHandler(seeds));
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });

// CLI: node server.ts --seeds seeds.json [--port 4010]
if (import.meta.main) {
  const a = process.argv.slice(2);
  const flag = (n: string) => a[a.indexOf(`--${n}`) + 1];
  const seeds = JSON.parse(readFileSync(flag('seeds'), 'utf8')) as SeedLike[];
  const srv = await startEvidenceHost(seeds, Number(flag('port') ?? 0));
  console.log(
    `evidence host on http://127.0.0.1:${(srv.address() as { port: number }).port}`,
  );
}
