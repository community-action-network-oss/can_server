import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { PolicyModule } from '../policy/policy.module.js';
import { StructuredContentValidator } from '../policy/app/structured-content-validator.js';
import { PolicyProposalsService } from './app/policy-proposals.service.js';
import { PolicyProposalsController } from './http/policy-proposals.controller.js';

@Module({
  imports: [AccountsModule, PolicyModule],
  controllers: [PolicyProposalsController],
  // own validator instance for report schemas (its compile cache is keyed by a fixed name per report kind)
  providers: [PolicyProposalsService, StructuredContentValidator],
})
export class PolicyProposalsModule {}
