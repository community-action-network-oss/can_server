import { Module } from '@nestjs/common';
import { AccountsModule } from './accounts/accounts.module.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { JurisdictionsModule } from './jurisdictions/jurisdictions.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { ProblemsModule } from './problems/problems.module.js';
import { PolicyModule } from './policy/policy.module.js';

@Module({
  imports: [
    PlatformModule,
    DbModule,
    HealthModule,
    PolicyModule,
    AccountsModule,
    ProblemsModule,
    JurisdictionsModule,
  ],
})
export class AppModule {}
