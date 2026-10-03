import { Module } from '@nestjs/common';
import { AuthRetention } from '../accounts/app/retention.js';
import { AccountsModule } from '../accounts/accounts.module.js';
import { DB, type Db } from '../db/db.module.js';
import { ModerationModule } from '../moderation/moderation.module.js';
import { ProblemRetention } from '../problems/app/retention.js';
import { FingerprintRepo } from '../problems/infra/fingerprint.repo.js';
import { ProblemsModule } from '../problems/problems.module.js';
import { RetentionJobs } from './retention.jobs.js';

/** DB, clock and queue come from the global modules. */
@Module({
  imports: [ProblemsModule, ModerationModule, AccountsModule],
  providers: [
    ProblemRetention,
    AuthRetention,
    {
      provide: FingerprintRepo,
      useFactory: (db: Db) => new FingerprintRepo(db),
      inject: [DB],
    },
    RetentionJobs,
  ],
})
export class RetentionModule {}
