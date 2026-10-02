import { Module } from '@nestjs/common';
import { AccountsModule } from './accounts/accounts.module.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { JurisdictionsModule } from './jurisdictions/jurisdictions.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { QueueModule } from './platform/queue/queue.module.js';
import { ProblemsModule } from './problems/problems.module.js';
import { PolicyModule } from './policy/policy.module.js';
import { PolicyProposalsModule } from './policy-proposals/policy-proposals.module.js';
import { StagesModule } from './stages/stages.module.js';
import { EventRelay } from './moderation/app/event-relay.js';
import { RelayCursor } from './moderation/infra/relay-cursor.js';
import { ModerationModule } from './moderation/moderation.module.js';

@Module({
  imports: [
    PlatformModule,
    QueueModule,
    DbModule,
    HealthModule,
    PolicyModule,
    PolicyProposalsModule,
    AccountsModule,
    ProblemsModule,
    StagesModule,
    ModerationModule,
    JurisdictionsModule,
  ],
  providers: [RelayCursor, EventRelay],
})
export class AppModule {}
