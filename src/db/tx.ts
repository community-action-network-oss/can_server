import type { Db } from './db.module.js';

/** The handle Drizzle passes inside db.transaction(). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const withTransaction = <T>(db: Db, fn: (tx: Tx) => Promise<T>) =>
  db.transaction(fn);
