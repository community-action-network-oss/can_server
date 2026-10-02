import { Module } from '@nestjs/common';
import { NotConfiguredGateway } from './app/not-configured-gateway.js';
import { AI_GATEWAY } from './domain/types.js';

/** Binds the only door to a model. Later units replace the placeholder with the real gateway. */
@Module({
  providers: [{ provide: AI_GATEWAY, useClass: NotConfiguredGateway }],
  exports: [AI_GATEWAY],
})
export class AiGatewayModule {}
