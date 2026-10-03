import { Module } from '@nestjs/common';
import { AiGatewayModule } from '../../ai-gateway/ai-gateway.module.js';
import { PrivacyGatewayModule } from '../../ai-gateway/app/redaction/privacy-gateway.module.js';
import { AuditPort } from '../../platform/audit/audit.service.js';
import {
  InMemoryRateLimiter,
  RATE_LIMITER,
} from '../../platform/security/rate-limiter.js';
import { PolicyModule } from '../policy.module.js';
import { AssistController } from './assist.controller.js';
import { AssistService } from './assist.service.js';

/** Separate from PolicyModule on purpose: PrivacyGatewayModule imports ModerationModule, which imports PolicyModule. */
@Module({
  imports: [PolicyModule, PrivacyGatewayModule, AiGatewayModule],
  controllers: [AssistController],
  providers: [
    AssistService,
    AuditPort,
    { provide: RATE_LIMITER, useClass: InMemoryRateLimiter },
  ],
})
export class AssistModule {}
