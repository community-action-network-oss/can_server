import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { PACK_SOURCE, type PackSource } from '../policy/app/pack-source.js';
import { PolicyStore } from '../policy/app/policy-store.js';
import { PolicyModule } from '../policy/policy.module.js';
import { DECISION_NOTIFIER } from '../problems/app/transition-ports.js';
import { DpRegistry } from './app/dp-registry.js';
import { RunRecorder } from './app/run-recorder.js';
import { RunStore } from './infra/run-store.js';
import { MailDecisionNotifier } from './infra/notifier.js';
import { RulesController } from './rules.controller.js';

@Module({
  imports: [PolicyModule, AccountsModule],
  controllers: [RulesController],
  providers: [
    MailDecisionNotifier,
    RunStore,
    RunRecorder,
    {
      provide: DpRegistry,
      useFactory: (s: PolicyStore, src: PackSource) => new DpRegistry(s, src),
      inject: [PolicyStore, PACK_SOURCE],
    },
    { provide: DECISION_NOTIFIER, useExisting: MailDecisionNotifier },
  ],
  exports: [
    DECISION_NOTIFIER,
    MailDecisionNotifier,
    RunStore,
    RunRecorder,
    DpRegistry,
  ],
})
export class ModerationModule {}
