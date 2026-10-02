import { Module } from '@nestjs/common';
import { ProblemsController } from './http/problems.controller.js';

@Module({ controllers: [ProblemsController] })
export class ProblemsModule {}
