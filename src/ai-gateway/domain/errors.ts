export type GatewayErrorCode =
  | 'gateway_not_configured'
  | 'delimiter_in_content'
  | 'over_budget'
  | 'bad_template'
  | 'bad_label'
  | 'duplicate_label'
  /** Legal lines were required and retrieval failed or was not supplied: the run holds (FAIL-CLOSED-AI-1). */
  | 'legal_unavailable'
  | 'invalid_register';

/** Typed gateway failure. Callers translate every code into `hold`; the message never carries user text. */
export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}
