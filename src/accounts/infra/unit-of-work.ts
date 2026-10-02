import { Inject, Injectable } from '@nestjs/common';
import { DB, type Db } from '../../db/db.module.js';
import { withTransaction } from '../../db/tx.js';
import { AuditPort } from '../../platform/audit/audit.service.js';
import type { Repos, UnitOfWork } from '../app/ports.js';
import {
  DrizzleAccountRepo,
  DrizzleInviteRepo,
  DrizzleLoginCodeRepo,
  DrizzleSessionRepo,
} from './repos.js';

@Injectable()
export class DrizzleUnitOfWork implements UnitOfWork {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditPort) private readonly audit: AuditPort,
  ) {}
  run<T>(fn: (r: Repos) => Promise<T>): Promise<T> {
    return withTransaction(this.db, (tx) =>
      fn({
        accounts: new DrizzleAccountRepo(tx),
        invites: new DrizzleInviteRepo(tx),
        codes: new DrizzleLoginCodeRepo(tx),
        sessions: new DrizzleSessionRepo(tx),
        audit: async (i) => void (await this.audit.record(tx, i)),
      }),
    );
  }
}
