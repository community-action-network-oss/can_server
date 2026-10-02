import { Module } from '@nestjs/common';
import { AuditPort } from '../../../platform/audit/audit.service.js';
import { TokenStore } from '../../infra/token-store.js';
import { PrivacyGateway } from './privacy-gateway.js';

/** DB and clock come from the global DbModule and PlatformModule. */
@Module({
  providers: [TokenStore, AuditPort, PrivacyGateway],
  exports: [PrivacyGateway, TokenStore],
})
export class PrivacyGatewayModule {}
