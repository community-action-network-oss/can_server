import { Module } from '@nestjs/common';
import { DecisionRecordService } from './app/decision-records.service.js';
import { DecisionsController } from './http/decisions.controller.js';

@Module({
  controllers: [DecisionsController],
  providers: [DecisionRecordService],
  exports: [DecisionRecordService],
})
export class DecisionsModule {}
