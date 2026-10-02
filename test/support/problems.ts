import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { inArray } from 'drizzle-orm';
import { config } from '../../src/config.js';
import * as schema from '../../src/db/schema.js';
import { PROTOCOL_VERSION } from '../../src/domain/protocol.js';
import { newId } from '../../src/domain/ids.js';

type D = NodePgDatabase<typeof schema>;

/** Rows created through these helpers; drop them with cleanup() in afterAll. */
export class ProblemFixtures {
  readonly problems: string[] = [];
  readonly accounts: string[] = [];
  constructor(private readonly db: D) {}

  async account(): Promise<string> {
    const id = newId();
    await this.db.insert(schema.account).values({
      id,
      emailCiphertext: Buffer.from('x'),
      emailHmac: Buffer.from(id),
      handle: `t-${id.slice(-12)}`,
      createdAt: new Date(),
      originNodeId: config.nodeId,
      protocolVersion: PROTOCOL_VERSION,
    });
    this.accounts.push(id);
    return id;
  }

  async problem(
    state: string,
    o: Partial<typeof schema.problem.$inferInsert> = {},
  ): Promise<string> {
    const id = newId();
    await this.db.insert(schema.problem).values({
      id,
      state,
      title: 'Transition engine fixture',
      helpNeeded: {
        skill_groups: [],
        languages: [],
        coarse_place: null,
        topics: [],
      },
      originNodeId: config.nodeId,
      protocolVersion: PROTOCOL_VERSION,
      ...o,
    });
    this.problems.push(id);
    return id;
  }

  async cleanup(): Promise<void> {
    if (this.problems.length) {
      await this.db
        .delete(schema.problemEvent)
        .where(inArray(schema.problemEvent.problemId, this.problems));
      await this.db
        .delete(schema.auditEvent)
        .where(inArray(schema.auditEvent.subjectId, this.problems));
      await this.db
        .delete(schema.problem)
        .where(inArray(schema.problem.id, this.problems));
    }
    if (this.accounts.length)
      await this.db
        .delete(schema.account)
        .where(inArray(schema.account.id, this.accounts));
  }
}
