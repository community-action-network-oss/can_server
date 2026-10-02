import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

describe('ai config', () => {
  it('defaults: fake provider, cap 10, deny, 6k/600 budgets, default register path', () => {
    const { ai } = loadConfig({});
    expect(ai).toMatchObject({
      provider: 'fake',
      spendCapMonthlyUsd: 10,
      dataCollection: 'deny',
      stageInputTokens: 6000,
      stageOutputTokens: 600,
      modelRegistryPath: 'config/model-register.json',
    });
  });
  it('refuses a live provider without its key, and a missing or non-positive cap', () => {
    expect(() => loadConfig({ AI_PROVIDER: 'openrouter' })).toThrow(
      /OPEN_ROUTER_KEY/,
    );
    expect(() => loadConfig({ AI_PROVIDER: 'anthropic' })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(() =>
      loadConfig({
        AI_PROVIDER: 'openrouter',
        OPEN_ROUTER_KEY: 'k',
        AI_SPEND_CAP_MONTHLY_USD: '0',
      }),
    ).toThrow(/AI_SPEND_CAP_MONTHLY_USD/);
  });
  it('budgets must be positive integers', () => {
    expect(() => loadConfig({ AI_STAGE_INPUT_TOKENS: '0' })).toThrow(
      /AI_STAGE_INPUT_TOKENS/,
    );
    expect(() => loadConfig({ AI_STAGE_OUTPUT_TOKENS: '1.5' })).toThrow(
      /AI_STAGE_OUTPUT_TOKENS/,
    );
  });
});
