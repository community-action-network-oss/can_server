import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { PolicyModule } from '../policy/policy.module.js';
import {
  CHOICE_GATE,
  CONTRIBUTION_PORT,
  FakeContributions,
  PassingChoiceGate,
} from './app/ports.js';
import { STAGE_PLAN_REPO } from './app/stage-plan.repository.js';
import { StagesService } from './app/stages.service.js';
import { StagesController } from './http/stages.controller.js';
import { DbStageChips } from './infra/stage-chips.js';
import { DrizzleStagePlanRepo } from './infra/stage-plan.repo.js';

@Module({
  imports: [AccountsModule, PolicyModule],
  controllers: [StagesController],
  providers: [
    { provide: STAGE_PLAN_REPO, useClass: DrizzleStagePlanRepo },
    { provide: CONTRIBUTION_PORT, useClass: FakeContributions },
    { provide: CHOICE_GATE, useClass: PassingChoiceGate },
    StagesService,
    DbStageChips,
  ],
  exports: [STAGE_PLAN_REPO, StagesService, DbStageChips],
})
export class StagesModule {}
