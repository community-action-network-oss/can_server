import type { Outcome } from '../domain/outcome.js';
import {
  detectCrisis,
  detectLegalProcess,
  type CrisisField,
} from '../domain/crisis/detect.js';
import type {
  CrisisCategory,
  CrisisEntry,
  CrisisLevel,
  LegalKind,
} from '../domain/crisis/lexicon.js';

export interface CrisisFirstInput {
  fields: CrisisField[];
  language?: string;
  /** Pack terms, when present. */
  extra?: CrisisEntry[];
}

/**
 * Codes only, no user text. `crisis` / `legal` are the deterministic DP-CRISIS / DP-LEGAL outcomes
 * (null = no signal; never `publish`: this layer never publishes anything).
 */
export interface CrisisFirstResult {
  route: 'static_resources' | 'none';
  level: CrisisLevel;
  hold: boolean;
  lane: boolean;
  crisis: Extract<Outcome, 'route_external' | 'escalate_human' | 'hold'> | null;
  legal: Extract<Outcome, 'escalate_human'> | null;
  categories: CrisisCategory[];
  legalKinds: LegalKind[];
  error: boolean;
}

/** Runs before the gateway. Never throws: any error is static resources plus hold. */
export function crisisFirst(input: CrisisFirstInput): CrisisFirstResult {
  try {
    const c = detectCrisis(input.fields, input.language, input.extra);
    const l = detectLegalProcess(input.fields);
    const shown = c.level === 'clear' || c.level === 'imminent';
    return {
      route: shown ? 'static_resources' : 'none',
      level: c.level,
      hold: c.level !== 'none' || l.hit,
      lane: c.level === 'imminent' || l.hit,
      crisis:
        c.level === 'imminent'
          ? 'escalate_human'
          : c.level === 'clear'
            ? 'route_external'
            : c.level === 'possible'
              ? 'hold'
              : null,
      legal: l.hit ? 'escalate_human' : null,
      categories: c.categories,
      legalKinds: l.kinds,
      error: false,
    };
  } catch {
    return {
      route: 'static_resources',
      level: 'possible',
      hold: true,
      lane: false,
      crisis: 'hold',
      legal: null,
      categories: [],
      legalKinds: [],
      error: true,
    };
  }
}
