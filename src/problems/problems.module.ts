import { Module } from '@nestjs/common';
import { PolicyModule } from '../policy/policy.module.js';
import { ModerationModule } from '../moderation/moderation.module.js';
import { AccountsModule } from '../accounts/accounts.module.js';
import { NullStageChips, STAGE_CHIP } from './app/stage-chip.port.js';
import { TransitionEngine } from './app/transition-engine.js';
import {
  NoReviewFacts,
  REVIEW_FACTS,
  TransitionEffects,
} from './app/transition-ports.js';
import {
  InMemoryRateLimiter,
  RATE_LIMITER,
} from '../platform/security/rate-limiter.js';
import { config } from '../config.js';
import { SchemaVersionRepo } from '../policy/infra/schema-version.repo.js';
import { FsPackSource } from '../policy/infra/fs-pack-source.js';
import { MigrationMaps } from '../policy/migration/migration-maps.js';
import { DraftMigrationService } from './app/draft-migration.service.js';
import { SubmitChecks, FINGERPRINTS } from './app/submit-checks.service.js';
import { FingerprintRepo } from './infra/fingerprint.repo.js';
import { DB, type Db } from '../db/db.module.js';
import { DraftsService } from './app/drafts.service.js';
import {
  DraftsController,
  MyProblemsController,
} from './http/drafts.controller.js';
import { ProblemsController } from './http/problems.controller.js';

@Module({
  imports: [AccountsModule, PolicyModule, ModerationModule],
  controllers: [ProblemsController, DraftsController, MyProblemsController],
  providers: [
    { provide: STAGE_CHIP, useClass: NullStageChips },
    { provide: REVIEW_FACTS, useClass: NoReviewFacts },
    TransitionEffects,
    TransitionEngine,
    DraftsService,
    DraftMigrationService,
    SubmitChecks,
    {
      provide: FINGERPRINTS,
      useFactory: (db: Db) => new FingerprintRepo(db),
      inject: [DB],
    },
    SchemaVersionRepo,
    {
      provide: MigrationMaps,
      useFactory: () =>
        new MigrationMaps(new FsPackSource(config.policyPacksDir)),
    },
    { provide: RATE_LIMITER, useClass: InMemoryRateLimiter },
  ],
  exports: [TransitionEngine, TransitionEffects],
})
export class ProblemsModule {}
