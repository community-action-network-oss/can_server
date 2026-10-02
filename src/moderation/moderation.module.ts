import { Module } from '@nestjs/common';
import { PolicyModule } from '../policy/policy.module.js';
import { RulesController } from './rules.controller.js';

@Module({ imports: [PolicyModule], controllers: [RulesController] })
export class ModerationModule {}
