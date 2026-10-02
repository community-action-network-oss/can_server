import { Module } from '@nestjs/common';
import { PolicyModule } from '../policy/policy.module.js';
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
import {
  InMemoryRateLimiter,
  RATE_LIMITER,
} from '../platform/security/rate-limiter.js';
import { DraftsService } from './app/drafts.service.js';
import {
  DraftsController,
  MyProblemsController,
} from './http/drafts.controller.js';
import { ProblemsController } from './http/problems.controller.js';

@Module({
  imports: [AccountsModule, PolicyModule],
  controllers: [ProblemsController, DraftsController, MyProblemsController],
  providers: [
    { provide: STAGE_CHIP, useClass: NullStageChips },
    { provide: REVIEW_FACTS, useClass: NoReviewFacts },
    { provide: DECISION_NOTIFIER, useClass: NoopDecisionNotifier },
    TransitionEffects,
    TransitionEngine,
    DraftsService,
    { provide: RATE_LIMITER, useClass: InMemoryRateLimiter },
  ],
  exports: [TransitionEngine, TransitionEffects],
})
export class ProblemsModule {}
