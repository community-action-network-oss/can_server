import { Module } from '@nestjs/common';
import { NullStageChips, STAGE_CHIP } from './app/stage-chip.port.js';
import { ProblemsController } from './http/problems.controller.js';

@Module({
  controllers: [ProblemsController],
  providers: [{ provide: STAGE_CHIP, useClass: NullStageChips }],
})
export class ProblemsModule {}
