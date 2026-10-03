import { Module } from '@nestjs/common';
import { LogAlertPort, ALERT_PORT } from './alert-port.js';
import { BudgetGuard } from './budget-guard.js';
import { CAPS_TOKEN } from './budget.tokens.js';
import { loadCaps } from './caps.js';

/** DB and clock come from the global DbModule and PlatformModule. */
@Module({
  providers: [
    BudgetGuard,
    { provide: CAPS_TOKEN, useFactory: () => loadCaps() },
    { provide: ALERT_PORT, useClass: LogAlertPort },
  ],
  exports: [BudgetGuard, CAPS_TOKEN],
})
export class BudgetModule {}
