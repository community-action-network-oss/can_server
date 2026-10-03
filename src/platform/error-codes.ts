export const ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'session_expired',
  'not_permitted',
  'not_found',
  'invalid_transition',
  'rate_limited',
  'cooldown_active',
  'reply_limit_reached',
  'conflict',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
