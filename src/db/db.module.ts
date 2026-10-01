import {
  Global,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config.js';
import * as schema from './schema.js';

export const POOL = Symbol('PG_POOL');
export const DB = Symbol('DRIZZLE');
export type Db = NodePgDatabase<typeof schema>;

@Injectable()
class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}
  async onApplicationShutdown() {
    await this.pool.end();
  }
}

// pg.Pool connects lazily, so building the app (e.g. OpenAPI generation) needs no database.
@Global()
@Module({
  providers: [
    {
      provide: POOL,
      useFactory: () => new pg.Pool({ connectionString: config.databaseUrl }),
    },
    {
      provide: DB,
      inject: [POOL],
      useFactory: (pool: pg.Pool): Db => drizzle(pool, { schema }),
    },
    PoolCloser,
  ],
  exports: [POOL, DB],
})
export class DbModule {}
