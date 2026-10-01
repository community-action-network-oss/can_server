import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';

@Module({ imports: [DbModule, HealthModule] })
export class AppModule {}
