import { ContentSchemaNotFound, type CompiledPack } from '../domain/pack.js';
import type { PolicyStore } from './policy-store.js';

export interface ContentSchemaResult {
  schema: Record<string, unknown>;
  schema_id: string;
  schema_version: string;
  schema_hash: string;
  policy_version: string;
  messages: Record<string, unknown>;
}

export class ContentSchemaRegistry {
  constructor(private readonly store: PolicyStore) {}

  /** `version` is a policy version string; an explicit retired one still resolves for replays. */
  get(
    type: string,
    opts: { jurisdiction?: string; version?: string } = {},
  ): ContentSchemaResult {
    let pack: CompiledPack | undefined;
    if (opts.version) {
      pack = this.store.findByVersion(opts.version);
      if (!pack)
        throw new ContentSchemaNotFound(
          `unknown policy version ${opts.version}`,
        );
    } else pack = this.store.active(opts.jurisdiction ?? 'default'); // may throw PolicyUnavailable
    const s = Object.hasOwn(pack.schemas, type)
      ? pack.schemas[type]
      : undefined;
    if (!s) throw new ContentSchemaNotFound(`no content schema "${type}"`);
    return {
      schema: s.schema,
      schema_id: s.schemaId,
      schema_version: s.schemaVersion,
      schema_hash: s.schemaHash,
      policy_version: pack.version,
      messages: s.messages,
    };
  }
}
