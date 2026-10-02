import { ADJECTIVES, NOUNS } from './wordlists.js';

/** rng returns a float in [0,1); injected so tests are deterministic. */
export type Rng = () => number;

const pick = (list: readonly string[], rng: Rng): string =>
  list[Math.floor(rng() * list.length)];

/** adjective-noun-NN, e.g. calm-otter-42 */
export function generateHandle(rng: Rng): string {
  const nn = String(Math.floor(rng() * 100)).padStart(2, '0');
  return `${pick(ADJECTIVES, rng)}-${pick(NOUNS, rng)}-${nn}`;
}
