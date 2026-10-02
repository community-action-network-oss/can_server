import { GatewayError } from '../domain/errors.js';
import type { AiGatewayPort, StageResult } from '../domain/types.js';

/** Placeholder until the real gateway lands: every run fails closed and callers translate it into `hold`. */
export class NotConfiguredGateway implements AiGatewayPort {
  run(): Promise<StageResult> {
    return Promise.reject(new GatewayError('gateway_not_configured'));
  }
}
