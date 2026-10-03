import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  GatewayOutput,
  ModelProvider,
  ProviderResult,
} from '../../domain/types.js';
import { ProviderError } from '../errors.js';

/** Sorted-key JSON so the same value always serialises to the same bytes. */
export const canonical = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : x,
  );

/** Key over stage, promptHash, dpId (when scoped) and the redacted data. Never the canary or system text. */
export const requestKey = (req: GatewayOutput, dpId = ''): string =>
  createHash('sha256')
    .update(canonical([req.stage, req.promptHash, dpId, req.data]))
    .digest('hex');

const file = (dir: string, key: string): string => join(dir, `${key}.json`);

/** Serves recorded responses. A miss throws `missing_recording`; it never calls out. */
export class ReplayProvider implements ModelProvider {
  constructor(
    readonly id: string,
    private readonly dir: string,
    private readonly dpId = '',
  ) {}

  complete(req: GatewayOutput): Promise<ProviderResult> {
    const f = file(this.dir, requestKey(req, this.dpId));
    if (!existsSync(f))
      return Promise.reject(
        new ProviderError(
          'missing_recording',
          `${req.stage} ${req.promptHash.slice(0, 12)}`,
        ),
      );
    return Promise.resolve(
      JSON.parse(readFileSync(f, 'utf8')) as ProviderResult,
    );
  }
}

/** Wraps a provider and stores its canonicalised responses. Only records when `enabled` (AI_RECORD=1, founder-gated). */
export class RecordingProvider implements ModelProvider {
  readonly id: string;
  constructor(
    private readonly inner: ModelProvider,
    private readonly dir: string,
    private readonly enabled: boolean,
    private readonly dpId = '',
  ) {
    this.id = inner.id;
  }

  async complete(req: GatewayOutput): Promise<ProviderResult> {
    const res = await this.inner.complete(req);
    if (this.enabled) {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(
        file(this.dir, requestKey(req, this.dpId)),
        canonical(res) + '\n',
      );
    }
    return res;
  }
}
