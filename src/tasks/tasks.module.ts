import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { ContributionsModule } from '../contributions/contributions.module.js';
import { CONTRIBUTION_PORT } from '../stages/app/ports.js';
import { DbContributionPort } from '../contributions/app/contribution-port.js';
import { PolicyModule } from '../policy/policy.module.js';
import { DbTaskPort } from './app/task-port.js';
import { TasksService } from './app/tasks.service.js';
import { TasksController } from './http/tasks.controller.js';

@Module({
  imports: [AccountsModule, ContributionsModule, PolicyModule],
  controllers: [TasksController],
  providers: [
    { provide: CONTRIBUTION_PORT, useExisting: DbContributionPort },
    DbTaskPort,
    TasksService,
  ],
  exports: [DbTaskPort],
})
export class TasksModule {}
