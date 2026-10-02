import { HttpException } from '@nestjs/common';
import type { Db } from '../../db/db.module.js';
import type { Tx } from '../../db/tx.js';
import type { SchemaVersionRepo } from '../infra/schema-version.repo.js';
import type { ContentSchemaRegistry } from './content-schema-registry.js';
import type { PolicyStore } from './policy-store.js';
import type { StructuredContentValidator } from './structured-content-validator.js';

export interface SchemaStamp {
  schemaId: string;
  schemaVersion: string;
  schemaHash: string;
}
export type SchemaErrorCode =
  | 'schema_unknown'
  | 'schema_retired'
  | 'schema_hash_mismatch'
  | 'schema_invalid';

/** Shared envelope; `reload: true` tells the client to refetch the schema. Pointers go in fieldErrors. */
export function schemaError(
  code: SchemaErrorCode,
  message: string,
  extra: { reload?: boolean; fieldErrors?: Record<string, string> } = {},
) {
  const status = code === 'schema_invalid' ? 400 : 409;
  return new HttpException({ error: { code, message, ...extra } }, status);
}

const RELOAD = 'The form changed. Reload it and try again.';

export class StructuredContentService {
  constructor(
    private readonly store: PolicyStore,
    private readonly registry: ContentSchemaRegistry,
    private readonly repo: SchemaVersionRepo,
    private readonly validator: StructuredContentValidator,
  ) {}

  /**
   * The stamp for a new draft: the active version, or the one the client asked for.
   * ponytail: activation is recorded lazily here (default jurisdiction only); a boot-time hook if retire timing must be exact.
   */
  async stamp(
    tx: Tx | Db,
    type: string,
    now: Date,
    ask: { version?: string; hash?: string } = {},
  ): Promise<SchemaStamp> {
    const a = this.registry.get(type); // may throw ContentSchemaNotFound / PolicyUnavailable
    await this.repo.activate(
      tx,
      {
        type,
        version: a.schema_version,
        packVersion: a.policy_version,
        hash: a.schema_hash,
      },
      now,
    );
    let { schema_id: id, schema_version: v, schema_hash: h } = a;
    if (ask.version || ask.hash) {
      const row = ask.version
        ? await this.repo.byVersion(tx, type, ask.version)
        : await this.repo.byHash(tx, type, ask.hash!);
      if (!row) throw schemaError('schema_unknown', RELOAD, { reload: true });
      if (ask.hash && row.schemaHash !== ask.hash)
        throw schemaError('schema_hash_mismatch', RELOAD, { reload: true });
      if (row.retiredAt)
        throw schemaError(
          'schema_retired',
          'This form version is retired. Reload to use the current one.',
        );
      v = row.version;
      h = row.schemaHash;
      id = a.schema_id;
    }
    return { schemaId: id, schemaVersion: v, schemaHash: h };
  }

  /** Validates against exactly the stamped version, even if it has since been retired (grace window: 10-u31). */
  async validate(
    tx: Tx | Db,
    type: string,
    stamp: SchemaStamp,
    body: unknown,
    mode: 'draft' | 'submit' = 'submit',
  ): Promise<void> {
    const row = await this.repo.byHash(tx, type, stamp.schemaHash);
    const entry =
      row && this.store.findByVersion(row.packVersion)?.schemas[type];
    if (!row || !entry || entry.schemaHash !== stamp.schemaHash)
      throw schemaError('schema_unknown', RELOAD, { reload: true });
    if (row.version !== stamp.schemaVersion)
      throw schemaError('schema_hash_mismatch', RELOAD, { reload: true });
    const violations = this.validator.validate(
      stamp.schemaHash,
      entry.schema,
      body,
      mode,
    );
    if (violations.length)
      throw schemaError('schema_invalid', 'Some answers need attention.', {
        fieldErrors: Object.fromEntries(
          violations.map((v) => [v.pointer || '/', v.message]),
        ),
      });
  }
}
