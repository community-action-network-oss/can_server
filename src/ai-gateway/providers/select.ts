import { readFileSync } from 'node:fs';
import type { ModelProvider } from '../domain/types.js';
import { ProviderError } from './errors.js';
import { FakeModel, type KeywordTable } from './fake/fake-model.js';
import { OpenRouterProvider } from './openrouter/openrouter.js';
import { ReplayProvider } from './replay/replay.js';
import type { ModelEntry } from '../register/model-register.js';

export interface ProviderEnv {
  NODE_ENV?: string;
  AI_PROVIDER?: string;
  AI_REPLAY_DIR?: string;
  AI_FAKE_TABLE?: string;
  OPEN_ROUTER_KEY?: string;
  AI_SPEND_CAP_MONTHLY_USD?: string;
  AI_DATA_COLLECTION?: string;
}

/** Live-provider inputs. Absent means a live provider is not selectable. */
export interface LiveDeps {
  entry: ModelEntry;
  fetch?: typeof fetch;
  synthetic?: boolean;
}

/**
 * Fake only under NODE_ENV=test or an explicit AI_PROVIDER=fake; replay only when asked and given a directory.
 * Anything else (including unset in production, and live providers, which are founder-gated) refuses.
 */
export function selectProvider(
  env: ProviderEnv,
  id = 'fake-1',
  live?: LiveDeps,
): ModelProvider {
  const p = env.AI_PROVIDER || (env.NODE_ENV === 'test' ? 'fake' : '');
  if (p === 'fake') {
    if (!env.AI_FAKE_TABLE)
      throw new ProviderError('not_selectable', 'AI_FAKE_TABLE is required');
    return new FakeModel(
      id,
      JSON.parse(readFileSync(env.AI_FAKE_TABLE, 'utf8')) as KeywordTable,
    );
  }
  if (p === 'replay') {
    if (!env.AI_REPLAY_DIR)
      throw new ProviderError('not_selectable', 'AI_REPLAY_DIR is required');
    return new ReplayProvider(id, env.AI_REPLAY_DIR);
  }
  if (p === 'openrouter') {
    // Explicit only: needs the register entry, key and cap; the constructor refuses anything missing.
    if (!live) throw new ProviderError('not_selectable', 'no register entry');
    return new OpenRouterProvider({
      entry: live.entry,
      apiKey: env.OPEN_ROUTER_KEY,
      spendCapMonthlyUsd: Number(env.AI_SPEND_CAP_MONTHLY_USD),
      dataCollection: env.AI_DATA_COLLECTION === 'allow' ? 'allow' : 'deny',
      synthetic: live.synthetic,
      fetch: live.fetch,
    });
  }
  throw new ProviderError('not_selectable', p || 'AI_PROVIDER unset');
}
