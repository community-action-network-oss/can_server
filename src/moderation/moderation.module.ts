import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { PolicyModule } from '../policy/policy.module.js';
import { DECISION_NOTIFIER } from '../problems/app/transition-ports.js';
import { MailDecisionNotifier } from './infra/notifier.js';
import { RulesController } from './rules.controller.js';

@Module({
  imports: [PolicyModule, AccountsModule],
  controllers: [RulesController],
  providers: [
    MailDecisionNotifier,
    { provide: DECISION_NOTIFIER, useExisting: MailDecisionNotifier },
  ],
  exports: [DECISION_NOTIFIER, MailDecisionNotifier],
})
export class ModerationModule {}
