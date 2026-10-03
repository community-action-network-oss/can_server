import { Module } from '@nestjs/common';
import { DecisionsModule } from '../decisions/decisions.module.js';
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
  TASK_PORT,
} from './app/ports.js';
import { LegalChoiceGate } from './app/choice/choice-gate.js';
import { StageEngine } from './app/stage-engine.js';
import { STAGE_PLAN_REPO } from './app/stage-plan.repository.js';
import { StageTemplatesService } from './app/stage-templates.service.js';
import { StagesService } from './app/stages.service.js';
import { StagesController } from './http/stages.controller.js';
import { DbStageChips } from './infra/stage-chips.js';
import { DrizzleStagePlanRepo } from './infra/stage-plan.repo.js';

@Module({
  imports: [
    AccountsModule,
    ContributionsModule,
    DecisionsModule,
    PolicyModule,
    ProblemsModule,
  ],
  controllers: [StagesController],
  providers: [
    { provide: STAGE_PLAN_REPO, useClass: DrizzleStagePlanRepo },
    { provide: CONTRIBUTION_PORT, useExisting: DbContributionPort },
    { provide: CHOICE_GATE, useClass: LegalChoiceGate },
    { provide: TASK_PORT, useClass: FakeTasks },
    { provide: BLOCKER_RECORD_PORT, useClass: EventBlockerRecords },
    StageEngine,
    StagesService,
    StageTemplatesService,
    DbStageChips,
  ],
  exports: [STAGE_PLAN_REPO, StagesService, StageEngine, DbStageChips],
})
export class StagesModule {}
