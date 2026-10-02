import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { PolicyModule } from './policy/policy.module.js';

@Module({ imports: [DbModule, HealthModule, PolicyModule] })
export class AppModule {}
