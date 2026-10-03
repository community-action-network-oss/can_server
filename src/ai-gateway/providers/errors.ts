export type ProviderErrorCode =
  | 'timeout'
  | 'refusal'
  | 'over_budget'
  | 'missing_recording'
  | 'not_selectable';

/** A provider failure. The gateway turns every one into `hold`; the message never carries prompt or user text. */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}
