import type { SchemaStamp } from '../../policy/app/structured-content.service.js';

type Pinned = {
  schemaId: string | null;
  schemaVersion: string | null;
  schemaHash: string | null;
};
export const stampOf = (r: Pinned): SchemaStamp | null =>
  r.schemaId && r.schemaVersion && r.schemaHash
    ? {
        schemaId: r.schemaId,
        schemaVersion: r.schemaVersion,
        schemaHash: r.schemaHash,
      }
    : null;
export const pin = (s: SchemaStamp | null) => ({
  schemaId: s?.schemaId ?? null,
  schemaVersion: s?.schemaVersion ?? null,
  schemaHash: s?.schemaHash ?? null,
});
