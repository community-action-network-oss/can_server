import { Global, Module } from '@nestjs/common';
import { AuditPort } from '../audit/audit.service.js';
import { PgQueue } from './pg-queue.js';
import { QUEUE_CONFIG, queueConfig } from './queue.config.js';
import { MathRandom, QueuePort, RANDOM } from './queue.port.js';
import { QueueWorker } from './worker.js';

@Global()
@Module({
  providers: [
    AuditPort,
    { provide: QUEUE_CONFIG, useValue: queueConfig },
    { provide: RANDOM, useClass: MathRandom },
    { provide: QueuePort, useClass: PgQueue },
    QueueWorker,
  ],
  exports: [QueuePort, QueueWorker],
})
export class QueueModule {}
