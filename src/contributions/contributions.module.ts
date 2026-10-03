import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { AuditPort } from '../platform/audit/audit.service.js';
import {
  InMemoryRateLimiter,
  RATE_LIMITER,
} from '../platform/security/rate-limiter.js';
import { PolicyModule } from '../policy/policy.module.js';
import { ATTESTATION_PORT, NullAttestation } from './app/attestation.port.js';
import { DbContributionPort } from './app/contribution-port.js';
import {
  CONTRIBUTION_PUBLISHED_HOOK,
  EvidenceTierService,
} from './app/evidence-tier.service.js';
import { ContributionsService } from './app/contributions.service.js';
import { ReplyAllowanceService } from './app/reply-cap.js';
import { ContributionsController } from './http/contributions.controller.js';
import { ReplyAllowanceController } from './http/reply-allowance.controller.js';

@Module({
  imports: [AccountsModule, PolicyModule],
  controllers: [ReplyAllowanceController, ContributionsController],
  providers: [
    ReplyAllowanceService,
    ContributionsService,
    DbContributionPort,
    EvidenceTierService,
    { provide: CONTRIBUTION_PUBLISHED_HOOK, useExisting: EvidenceTierService },
    AuditPort,
    { provide: RATE_LIMITER, useClass: InMemoryRateLimiter },
    { provide: ATTESTATION_PORT, useClass: NullAttestation },
  ],
  exports: [
    ReplyAllowanceService,
    ContributionsService,
    DbContributionPort,
    CONTRIBUTION_PUBLISHED_HOOK,
  ],
})
export class ContributionsModule {}
