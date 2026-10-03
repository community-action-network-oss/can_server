import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { RelayCursor } from '../moderation/infra/relay-cursor.js';
import { FollowsController } from './follows.controller.js';
import { FollowsService } from './follows.service.js';
import { NotificationFanout } from './notification-fanout.js';

@Module({
  imports: [AccountsModule],
  controllers: [FollowsController],
  providers: [FollowsService, NotificationFanout, RelayCursor],
  exports: [NotificationFanout],
})
export class NotificationsModule {}
