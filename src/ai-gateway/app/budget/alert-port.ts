import { Logger } from '@nestjs/common';

export const ALERT_PORT = Symbol('AlertPort');

export interface SpendAlert {
  capKey: string;
  level: 50 | 80 | 100;
  day: string;
  usedMicroUsd: number;
  capMicroUsd: number;
}

/** Alerts stay in-house: the log adapter (and the spend_alert table) only, never email or a webhook. */
export interface AlertPort {
  emit(alert: SpendAlert): void;
}

export class LogAlertPort implements AlertPort {
  private readonly log = new Logger('SpendCap');
  emit(a: SpendAlert): void {
    this.log.warn(JSON.stringify({ event: 'spend_cap_alert', ...a }));
  }
}
