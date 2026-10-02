import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { DB, type Db } from '../../db/db.module.js';
import { problem, problemEvent } from '../../db/schema.js';
import { withTransaction, type Tx } from '../../db/tx.js';
import { PROTOCOL_VERSION } from '../../domain/protocol.js';
import { ApiException } from '../../platform/errors.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import { PolicyStore } from '../../policy/app/policy-store.js';
import {
  StructuredContentService,
  schemaError,
  type SchemaStamp,
} from '../../policy/app/structured-content.service.js';
import {
  ContentSchemaNotFound,
  PolicyUnavailable,
} from '../../policy/domain/pack.js';
import {
  applyMap,
  classifyBump,
  mappingKey,
  type Bump,
  type MappingRow,
  type MigrationMap,
} from '../../policy/migration/migrate.js';
import { MigrationMaps } from '../../policy/migration/migration-maps.js';
import { SchemaVersionRepo } from '../../policy/infra/schema-version.repo.js';
import { pin, stampOf } from './schema-stamp.js';

type Row = typeof problem.$inferSelect;
const TYPE = 'problem';
const DAY = 86_400_000;
const DEFAULT_GRACE_DAYS = 30;
// Published states are absent on purpose: published content keeps its schema version forever.
const MIGRATABLE = ['draft', 'in_review', 'needs_revision', 'held'];
const EDITABLE = ['draft', 'needs_revision', 'in_review'];
const notFound = () => new ApiException(404, 'not_found', 'Problem not found');
const required = () =>
  new ApiException(
    409,
    'schema_migration_required',
    'The form has changed. Move your answers to the new form first.',
  );

export interface MigrationPlanView {
  state: 'pinned' | 'migrated';
  bump: Bump;
  current: SchemaStamp;
  target: SchemaStamp;
  graceEndsAt: Date | null;
  mapping: MappingRow[];
  newRequired: string[];
  dropped: string[];
}

interface Plan {
  bump: Bump;
  from: SchemaStamp;
  target: SchemaStamp;
  graceEndsAt: Date | null;
  map: MigrationMap | null;
  allowed: string[] | undefined;
}

@Injectable()
export class DraftMigrationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(StructuredContentService)
    private readonly structured: StructuredContentService,
    @Inject(PolicyStore) private readonly store: PolicyStore,
    @Inject(SchemaVersionRepo) private readonly repo: SchemaVersionRepo,
    @Inject(MigrationMaps) private readonly maps: MigrationMaps,
  ) {}

  /** What this draft would move to. Null: unstamped draft or no active policy, so nothing to do. */
  private async plan(tx: Tx, row: Row, now: Date): Promise<Plan | null> {
    const from = stampOf(row);
    if (!from) return null;
    let target: SchemaStamp;
    try {
      target = await this.structured.stamp(tx, TYPE, now);
    } catch (e) {
      if (e instanceof PolicyUnavailable || e instanceof ContentSchemaNotFound)
        return null;
      throw e;
    }
    let bump = classifyBump(from.schemaVersion, target.schemaVersion);
    if (target.schemaHash === from.schemaHash) bump = 'none';
    else if (bump === 'none') bump = 'patch'; // same version string, new hash
    const plan: Plan = {
      bump,
      from,
      target,
      graceEndsAt: null,
      map: null,
      allowed: undefined,
    };
    if (bump !== 'major') return plan;
    const pack = this.store.active('default');
    const props = (pack.schemas[TYPE]?.schema as { properties?: object })
      ?.properties;
    plan.allowed = props ? Object.keys(props) : undefined;
    const days = graceDays(pack.limits);
    // ponytail: the window opens when the new version is first recorded (lazily, on first stamp), not at ratification.
    const t = await this.repo.byHash(tx, TYPE, target.schemaHash);
    plan.graceEndsAt = t
      ? new Date(t.activatedAt.getTime() + days * DAY)
      : null;
    plan.map = await this.maps.find(
      pack.chain,
      TYPE,
      from.schemaVersion,
      target.schemaVersion,
    );
    return plan;
  }

  private event(tx: Tx, row: Row, payload: Record<string, unknown>, now: Date) {
    return tx.insert(problemEvent).values({
      id: this.ids.next(),
      problemId: row.id,
      type: 'draft_schema_migrated',
      actorId: row.initiatorId,
      fromState: row.state,
      toState: row.state,
      payload,
      prevHash: null,
      originNodeId: config.nodeId,
      protocolVersion: PROTOCOL_VERSION,
      occurredAt: now,
    });
  }

  /** Minor and patch: restamp, carry every answer, no confirmation. Never touches a published row. */
  private async restamp(
    tx: Tx,
    row: Row,
    p: Plan,
    now: Date,
    bumpVersion: boolean,
  ): Promise<Row> {
    const set = {
      ...pin(p.target),
      ...(bumpVersion && { version: row.version + 1, updatedAt: now }),
    };
    await tx.update(problem).set(set).where(eq(problem.id, row.id));
    await this.event(
      tx,
      row,
      {
        from: p.from.schemaVersion,
        to: p.target.schemaVersion,
        bump: p.bump,
        auto: true,
      },
      now,
    );
    return { ...row, ...set };
  }

  private expired(p: Plan, now: Date) {
    return (
      p.bump === 'major' &&
      !!p.map &&
      !!p.graceEndsAt &&
      now.getTime() >= p.graceEndsAt.getTime()
    );
  }

  /**
   * Called inside the owner's own write transaction (edit, submit): auto-migrates minor and patch bumps,
   * and refuses content edits and submit on a draft whose major grace window has ended.
   * Returns the row with its current stamp.
   */
  async beforeWrite(
    tx: Tx,
    row: Row,
    opts: { content: boolean },
  ): Promise<Row> {
    if (row.publishedAt || !MIGRATABLE.includes(row.state)) return row;
    const now = this.clock.now();
    const p = await this.plan(tx, row, now);
    if (!p) return row;
    if (p.bump === 'minor' || p.bump === 'patch')
      return this.restamp(tx, row, p, now, false);
    if (this.expired(p, now) && opts.content) throw required();
    return row;
  }

  async beforeSubmit(tx: Tx, row: Row): Promise<void> {
    await this.beforeWrite(tx, row, { content: true });
  }

  private async lock(tx: Tx, id: string, accountId: string): Promise<Row> {
    const [r] = await tx
      .select()
      .from(problem)
      .where(eq(problem.id, id))
      .for('update');
    if (!r || r.initiatorId !== accountId || r.deletedAt) throw notFound();
    if (r.publishedAt || !MIGRATABLE.includes(r.state))
      throw new ApiException(
        409,
        'invalid_transition',
        'Published content keeps the form it was written with.',
      );
    return r;
  }

  private async planOrFail(tx: Tx, row: Row, now: Date): Promise<Plan> {
    const p = await this.plan(tx, row, now);
    if (!p)
      throw schemaError('schema_unknown', 'This draft has no form version.');
    return p;
  }

  private view(p: Plan, content: unknown, state: 'pinned' | 'migrated') {
    const m = p.map
      ? applyMap(
          (content ?? {}) as Record<string, unknown>,
          p.map,
          null,
          p.allowed,
        )
      : null;
    return {
      state,
      bump: p.bump,
      current: p.from,
      target: p.target,
      graceEndsAt: p.graceEndsAt,
      mapping: m?.mapping ?? [],
      newRequired: m?.new_required ?? [],
      dropped: m?.dropped ?? [],
    } satisfies MigrationPlanView;
  }

  async preview(accountId: string, id: string): Promise<MigrationPlanView> {
    const now = this.clock.now();
    return withTransaction(this.db, async (tx) => {
      const row = await this.lock(tx, id, accountId);
      const p = await this.planOrFail(tx, row, now);
      if (p.bump === 'minor' || p.bump === 'patch') {
        await this.restamp(tx, row, p, now, true);
        return this.view(p, null, 'migrated');
      }
      if (p.bump === 'major' && !p.map)
        throw new ApiException(
          409,
          'schema_migration_unavailable',
          'No migration is available for this form change yet.',
        );
      return this.view(
        p,
        row.content,
        p.bump === 'none' ? 'migrated' : 'pinned',
      );
    });
  }

  async confirm(
    accountId: string,
    id: string,
    expectedVersion: number,
    mappings: { from_path: string; to_path: string }[],
  ) {
    const now = this.clock.now();
    return withTransaction(this.db, async (tx) => {
      const row = await this.lock(tx, id, accountId);
      if (!EDITABLE.includes(row.state))
        throw new ApiException(
          409,
          'invalid_transition',
          'This problem can no longer be edited.',
        );
      if (row.version !== expectedVersion)
        throw new ApiException(
          409,
          'conflict',
          'The problem changed; reload and retry.',
        );
      const p = await this.planOrFail(tx, row, now);
      let out: Row;
      if (p.bump === 'minor' || p.bump === 'patch')
        out = await this.restamp(tx, row, p, now, true);
      else if (p.bump !== 'major' || !p.map)
        throw new ApiException(
          409,
          p.bump === 'major'
            ? 'schema_migration_unavailable'
            : 'invalid_transition',
          'There is nothing to migrate.',
        );
      else {
        const known = new Set(p.map.fields.map(mappingKey));
        const bad = mappings.filter((m) => !known.has(mappingKey(m)));
        if (bad.length)
          throw new ApiException(
            400,
            'validation_failed',
            'Some mappings are not part of this migration.',
            Object.fromEntries(bad.map((m, i) => [`mappings/${i}`, 'unknown'])),
          );
        // ponytail: carried answers are not re-validated here; new bounds apply at the next save or submit.
        const r = applyMap(
          (row.content ?? {}) as Record<string, unknown>,
          p.map,
          new Set(mappings.map(mappingKey)),
          p.allowed,
        );
        const set = {
          ...(row.content && { content: r.content }),
          ...pin(p.target),
          version: row.version + 1,
          updatedAt: now,
        };
        await tx.update(problem).set(set).where(eq(problem.id, id));
        await this.event(
          tx,
          row,
          {
            from: p.from.schemaVersion,
            to: p.target.schemaVersion,
            bump: 'major',
            auto: false,
            confirmed: mappings.length,
          },
          now,
        );
        out = { ...row, ...set };
      }
      return {
        id,
        state: out.state,
        version: out.version,
        updatedAt: out.updatedAt.toISOString(),
        ...pin(stampOf(out)),
      };
    });
  }
}

const graceDays = (limits: Record<string, unknown>): number => {
  const g = (limits.grace as Record<string, unknown> | undefined)
    ?.schema_major_draft_days;
  const v = typeof g === 'object' && g ? (g as { value?: unknown }).value : g;
  return typeof v === 'number' && v > 0 ? v : DEFAULT_GRACE_DAYS;
};
