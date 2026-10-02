import { Module } from '@nestjs/common';
import { ModerationModule } from '../../../moderation/moderation.module.js';
import { AuditPort } from '../../../platform/audit/audit.service.js';
import { TokenStore } from '../../infra/token-store.js';
import { PrivacyGateway } from './privacy-gateway.js';
import { TokenRetention } from './token-retention.js';

/** DB, clock and queue come from the global DbModule, PlatformModule and QueueModule. */
@Module({
  imports: [ModerationModule],
  providers: [TokenStore, AuditPort, PrivacyGateway, TokenRetention],
  exports: [PrivacyGateway, TokenStore],
})
export class PrivacyGatewayModule {}
