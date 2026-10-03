import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { DbContributionPort } from '../contributions/app/contribution-port.js';
import { ContributionsModule } from '../contributions/contributions.module.js';
import { PolicyModule } from '../policy/policy.module.js';
import { ProblemsModule } from '../problems/problems.module.js';
import {
  BLOCKER_RECORD_PORT,
  CHOICE_GATE,
  CONTRIBUTION_PORT,
  EventBlockerRecords,
  FakeTasks,
  PassingChoiceGate,
  TASK_PORT,
} from './app/ports.js';
import { StageEngine } from './app/stage-engine.js';
import { STAGE_PLAN_REPO } from './app/stage-plan.repository.js';
import { StagesService } from './app/stages.service.js';
import { StagesController } from './http/stages.controller.js';
import { DbStageChips } from './infra/stage-chips.js';
import { DrizzleStagePlanRepo } from './infra/stage-plan.repo.js';

@Module({
  imports: [AccountsModule, ContributionsModule, PolicyModule, ProblemsModule],
  controllers: [StagesController],
  providers: [
    { provide: STAGE_PLAN_REPO, useClass: DrizzleStagePlanRepo },
    { provide: CONTRIBUTION_PORT, useExisting: DbContributionPort },
    { provide: CHOICE_GATE, useClass: PassingChoiceGate },
    { provide: TASK_PORT, useClass: FakeTasks },
    { provide: BLOCKER_RECORD_PORT, useClass: EventBlockerRecords },
    StageEngine,
    StagesService,
    DbStageChips,
  ],
  exports: [STAGE_PLAN_REPO, StagesService, StageEngine, DbStageChips],
})
export class StagesModule {}
