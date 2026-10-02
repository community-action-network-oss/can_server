import type { PackFiles } from '../domain/hash.js';

/** Port: where pack files come from. Slice 1 is a directory (infra/fs-pack-source.ts). */
export interface PackSource {
  read(name: string, semver: string): Promise<PackFiles>;
}
export const PACK_SOURCE = Symbol('PACK_SOURCE');
