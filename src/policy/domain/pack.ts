export const LAYERS = [
  'base',
  'constitution',
  'jurisdiction',
  'local',
] as const;
export type Layer = (typeof LAYERS)[number];

/** Constitution I.2 (PREC-1): earlier is higher. */
export const TIERS = [
  'rights',
  'crisis_safety',
  'privacy',
  'legal_gate',
  'procedure',
  'ranking',
] as const;
export type Tier = (typeof TIERS)[number];

/** Earlier is weaker. A lower layer may only move to the right. */
export const ENFORCEMENT = [
  'advisory',
  'needs_revision',
  'reject',
  'hold',
] as const;
export type Enforcement = (typeof ENFORCEMENT)[number];

export interface Rule {
  id: string;
  tier: Tier;
  enforcement: Enforcement;
  text: string;
  source: string; // pack name that last set this rule
}

export interface SchemaEntry {
  type: string;
  schema: Record<string, unknown>;
  schemaId: string;
  schemaVersion: string;
  schemaHash: string;
  messages: Record<string, unknown>;
}

export interface ChainLink {
  name: string;
  semver: string;
  hash: string;
  layer: Layer;
}

export interface Ratification {
  approvedBy: string;
  expiresAt: string;
}

export interface CompiledPack {
  name: string;
  semver: string;
  hash: string;
  version: string;
  layer: Layer;
  jurisdiction: string | null;
  chain: ChainLink[]; // base first, this pack last
  rules: Rule[]; // sorted by tier then id
  protectedCore: string[];
  limits: Record<string, unknown>;
  schemas: Record<string, SchemaEntry>;
  ratification: Ratification;
}

export class PolicyUnavailable extends Error {
  constructor(message = 'no valid policy pack is active') {
    super(message);
  }
}
export class PackRefused extends Error {}
export class ContentSchemaNotFound extends Error {}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}
