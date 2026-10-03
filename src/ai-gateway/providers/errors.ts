export type ProviderErrorCode =
  | 'timeout'
  | 'refusal'
  | 'over_budget'
  | 'missing_recording'
  | 'not_selectable'
  | 'provider_unavailable'
  | 'provider_budget'
  | 'schema_invalid'
  | 'endpoint_not_allowed';

/** A provider failure. The gateway turns every one into `hold`; the message never carries prompt or user text. */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    detail?: string,
    /** Seconds the provider asked us to wait (429/5xx). The router owns backoff. */
    readonly retryAfter?: number,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}
