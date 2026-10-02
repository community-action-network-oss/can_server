import { Global, Module } from '@nestjs/common';
import { PrivacyGateway } from '../ai-gateway/app/redaction/privacy-gateway.js';
import { PrivacyGatewayModule } from '../ai-gateway/app/redaction/privacy-gateway.module.js';
import { AccountsModule } from '../accounts/accounts.module.js';
import { PolicyModule } from '../policy/policy.module.js';
import { ProblemsModule } from '../problems/problems.module.js';
import {
  REVIEW_FACTS,
  REVIEW_HOOKS,
} from '../problems/app/transition-ports.js';
import { PROBLEM_MASKER } from './app/masker.js';
import { PosterReviewService } from './app/poster-review.service.js';
import { ReviewFactsImpl, ReviewHooksImpl } from './app/review-core.js';
import { ReviewService } from './app/review.service.js';
import {
  PosterReviewController,
  ReviewController,
  ReviewOptInController,
} from './http/review.controller.js';

/** Binds the review facts and hooks the problems module asks for. Needs only the DB and the clock, so it creates no import cycle. */
@Global()
@Module({
  imports: [PolicyModule],
  providers: [
    ReviewFactsImpl,
    ReviewHooksImpl,
    { provide: REVIEW_FACTS, useExisting: ReviewFactsImpl },
    { provide: REVIEW_HOOKS, useExisting: ReviewHooksImpl },
  ],
  exports: [ReviewFactsImpl, REVIEW_FACTS, REVIEW_HOOKS],
})
export class ReviewCoreModule {}

@Module({
  imports: [
    ReviewCoreModule,
    AccountsModule,
    PolicyModule,
    ProblemsModule,
    PrivacyGatewayModule,
  ],
  controllers: [
    ReviewController,
    ReviewOptInController,
    PosterReviewController,
  ],
  providers: [
    { provide: PROBLEM_MASKER, useExisting: PrivacyGateway },
    ReviewService,
    PosterReviewService,
  ],
})
export class ReviewModule {}
