import { Module } from '@nestjs/common';
import { StageOptionsController } from './stage-options.controller.js';
import { StageOptionsService } from './stage-options.service.js';

@Module({
  controllers: [StageOptionsController],
  providers: [StageOptionsService],
})
export class StageOptionsModule {}
