import pg from 'pg';
import { config } from './config.js';
import { seedFictionalFixture } from './seed/fixtures.js';
import { seedStageFixture } from './seed/stage-fixtures.js';
import { DEV_INVITE_CODES, RESET_SQL, seedWorld } from './seed/world.js';

// Local development data only: refuses production and any non-local database.
if (config.nodeEnv === 'production')
  throw new Error('seed refuses to run when NODE_ENV=production');
const host = new URL(config.databaseUrl).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host))
  throw new Error('seed only runs against the local compose database');

const args = new Set(process.argv.slice(2));
const pool = new pg.Pool({ connectionString: config.databaseUrl });
try {
  if (args.has('--reset')) {
    // Stage rows point at problems; clear them (and what points at them) first.
    await pool.query('truncate table stage cascade');
    await pool.query(RESET_SQL);
  }
  const w = await seedWorld(pool);
  console.log(
    `seeded ${w.accounts.length} accounts, ${w.jurisdictions} jurisdictions, ${w.invites} invites`,
  );
  for (const a of w.accounts) console.log(`  ${a.email}  ${a.handle}`);
  // Dev-only invite codes; stored as hashes. Never printed outside development.
  if (config.nodeEnv === 'development')
    console.log(`dev invite codes: ${DEV_INVITE_CODES.join(', ')}`);
  if (args.has('--fixture')) {
    console.log(`fixture problems: ${await seedFictionalFixture(pool)}`);
    console.log(`fixture stages: ${await seedStageFixture(pool)}`);
  }
  // Seed bootstrap loader (11-u18) does not exist yet; real seed problems never come from here.
} finally {
  await pool.end();
}
