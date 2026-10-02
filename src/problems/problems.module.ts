import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { NullStageChips, STAGE_CHIP } from './app/stage-chip.port.js';
import { TransitionEngine } from './app/transition-engine.js';
import {
  DECISION_NOTIFIER,
  NoReviewFacts,
  NoopDecisionNotifier,
  REVIEW_FACTS,
  TransitionEffects,
} from './app/transition-ports.js';
import { ProblemsController } from './http/problems.controller.js';

@Module({
  imports: [AccountsModule],
  controllers: [ProblemsController],
  providers: [
    { provide: STAGE_CHIP, useClass: NullStageChips },
    { provide: REVIEW_FACTS, useClass: NoReviewFacts },
    { provide: DECISION_NOTIFIER, useClass: NoopDecisionNotifier },
    TransitionEffects,
    TransitionEngine,
  ],
  exports: [TransitionEngine, TransitionEffects],
})
export class ProblemsModule {}
