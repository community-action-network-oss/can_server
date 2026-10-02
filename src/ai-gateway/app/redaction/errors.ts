import { GatewayError, type GatewayErrorCode } from '../../domain/errors.js';

/**
 * Front-half failures. Subclasses GatewayError so callers' "any GatewayError means hold" holds.
 * ponytail: domain/errors.ts is outside 09-u09 WRITES, so the codes are cast; add them to GatewayErrorCode when that file is next touched.
 */
export class PrivacyGatewayError extends GatewayError {
  constructor(code: 'gateway_failure' | 'zone_violation', detail?: string) {
    super(code as GatewayErrorCode, detail);
  }
}
