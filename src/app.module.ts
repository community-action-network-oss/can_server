import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { PolicyModule } from './policy/policy.module.js';

@Module({ imports: [PlatformModule, DbModule, HealthModule, PolicyModule] })
export class AppModule {}
