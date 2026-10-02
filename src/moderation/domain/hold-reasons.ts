/** Closed hold reason codes (safety-and-privacy.md fail-closed matrix). */
export const HOLD_REASONS = [
  'provider_timeout',
  'schema_invalid',
  'low_confidence',
  'language_unsupported',
  'pack_missing',
  'budget_exhausted',
  'canary_tripped',
  'gateway_failure',
  'policy_conflict',
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];
