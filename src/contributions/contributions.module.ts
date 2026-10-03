import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { PolicyModule } from '../policy/policy.module.js';
import { ReplyAllowanceService } from './app/reply-cap.js';
import { ReplyAllowanceController } from './http/reply-allowance.controller.js';

@Module({
  imports: [AccountsModule, PolicyModule],
  controllers: [ReplyAllowanceController],
  providers: [ReplyAllowanceService],
  exports: [ReplyAllowanceService],
})
export class ContributionsModule {}
