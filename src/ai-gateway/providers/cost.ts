/** Deterministic token estimate for fakes: a fixed 4 chars per token. */
export const fakeTokens = (text: string): number => Math.ceil(text.length / 4);

/** Micro-USD for `tokens` at `usdPerMtok` (USD per million tokens is exactly micro-USD per token). */
export const costMicroUsd = (tokens: number, usdPerMtok: number): number =>
  Math.ceil(tokens * usdPerMtok);
