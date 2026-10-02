import { Inject, Injectable } from '@nestjs/common';
import { config } from '../../config.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';
import { auditEvent } from '../../db/schema.js';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '../ports.js';

/** Anything with Drizzle's insert(), so a transaction or the db itself works. */
export interface AuditTx {
  insert: (t: typeof auditEvent) => {
    values: (v: typeof auditEvent.$inferInsert) => PromiseLike<unknown>;
  };
}

export interface AuditInput {
  actorId?: string | null;
  action: string;
  subjectType: string;
  subjectId?: string | null;
  detail?: Record<string, unknown>;
  transitional?: boolean;
  ipClass?: string | null;
}

const SECRET_KEY = /email|token|code|password|ciphertext/i;

/** Throws if any key at any depth looks like a secret. */
export function assertNoSecretKeys(v: unknown, path = 'detail'): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertNoSecretKeys(x, `${path}[${i}]`));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEY.test(k)) {
        throw new Error(
          `audit detail may not contain secret key "${path}.${k}"`,
        );
      }
      assertNoSecretKeys(x, `${path}.${k}`);
    }
  }
}

@Injectable()
export class AuditPort {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async record(tx: AuditTx, i: AuditInput): Promise<string> {
    const detail = i.detail ?? {};
    assertNoSecretKeys(detail);
    const id = this.ids.next();
    await tx.insert(auditEvent).values({
      id,
      actorId: i.actorId ?? null,
      action: i.action,
      subjectType: i.subjectType,
      subjectId: i.subjectId ?? null,
      detail,
      transitional: i.transitional ?? false,
      ipClass: i.ipClass ?? null,
      at: this.clock.now(),
      originNodeId: config.nodeId,
      protocolVersion: PROTOCOL_VERSION,
    });
    return id;
  }
}
