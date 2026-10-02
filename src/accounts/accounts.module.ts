import { randomInt } from 'node:crypto';
import { Module } from '@nestjs/common';
import { config } from '../config.js';
import { AuditPort } from '../platform/audit/audit.service.js';
import { AuthService } from './app/auth.service.js';
import {
  AUTH_SETTINGS,
  HAS_PUBLISHED_CONTENT,
  UNIT_OF_WORK,
  type AuthSettings,
} from './app/ports.js';
import { NoPublishedContent } from './infra/no-published-content.js';
import { DrizzleUnitOfWork } from './infra/unit-of-work.js';

@Module({
  providers: [
    AuthService,
    AuditPort,
    { provide: UNIT_OF_WORK, useClass: DrizzleUnitOfWork },
    { provide: HAS_PUBLISHED_CONTENT, useClass: NoPublishedContent },
    {
      provide: AUTH_SETTINGS,
      useFactory: (): AuthSettings => ({
        encKey: Buffer.from(config.emailEncKey, 'base64'),
        indexKey: Buffer.from(config.emailIndexKey, 'base64'),
        inviteKey: Buffer.from(config.inviteHashKey, 'base64'),
        codeTtlMinutes: config.codeTtlMinutes,
        codeMaxAttempts: config.codeMaxAttempts,
        sessionIdleDays: config.sessionIdleDays,
        sessionAbsoluteDays: config.sessionAbsoluteDays,
        rng: () => randomInt(0, 2 ** 31) / 2 ** 31,
      }),
    },
  ],
  exports: [AuthService, AuditPort],
})
export class AccountsModule {}
