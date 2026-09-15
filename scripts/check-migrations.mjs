#!/usr/bin/env node
/**
 * Applies every migration to a real Postgres and checks what came out.
 *
 * Complements scripts/ci-db-smoke.mjs rather than replacing it: that one only
 * asserts the expected tables exist. This checks what 005 actually did, and it
 * runs with or without a database - Postgres compiled to WASM needs no daemon,
 * no container and no service, so a migration can be checked on a laptop with
 * Docker stopped, which is exactly the situation 005 was written in.
 *
 * What it actually proves, beyond "the SQL parses":
 *
 *   1. Migration 005 has to widen 23 money columns from six decimal places to
 *      eighteen, and Postgres refuses ALTER COLUMN TYPE on any column a view
 *      selects. Seven views do. So 005 drops them, alters, and writes them out
 *      again by hand - and hand-copied SQL is exactly the kind of thing that
 *      comes back subtly different. This captures every view definition from
 *      the catalog before 005 runs and again after, and fails on any change.
 *
 *   2. That nothing is left at six decimal places, which is the failure the
 *      widening exists to prevent: the indexer stores human amounts, so a
 *      partial fill below 1e-6 WETH would have rounded to zero.
 *
 * Runs against a real Postgres when DATABASE_URL is set - point it at the
 * timescale image CI uses, so the hypertables are real - and against
 * Postgres-in-WASM otherwise. The WASM path skips the two timescaledb
 * statements it cannot run, which is the one thing it cannot check:
 * prob_snapshots is a hypertable and 005 alters two of its columns.
 *
 * Usage:
 *   node scripts/check-migrations.mjs
 *   DATABASE_URL=postgres://... node scripts/check-migrations.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'backend', 'src', 'db', 'migrations')

/** The migration whose view round-trip is being checked. */
const ROUND_TRIP_AT = '005_rhc.sql'

/**
 * Views this check would otherwise flag as "changed across 005_rhc.sql",
 * because a LATER migration deliberately changes them again for its own,
 * separate reason - not because 005's drop-and-recreate came out wrong.
 *
 * stale_settlements: 006_match_tied.sql adds an upper bound
 * (settle_at > NOW() - 25 hours) so a match that will never get settled=TRUE
 * in this projection - which a tie was, before 006, and which a permissionless
 * emergencyRefundMatch still is, since the indexer has no event handler for
 * it - ages back out of "currently overdue" instead of pinning /health/deep
 * red forever. See 006_match_tied.sql's own comment.
 */
const EXPECTED_FURTHER_CHANGES = new Set(['stale_settlements'])

const DATABASE_URL = process.env.DATABASE_URL
const usingRealPg = Boolean(DATABASE_URL)

let exec, q, close
if (usingRealPg) {
  // `pg` is a backend dependency, and pnpm does not hoist it to the root, so
  // a bare import from scripts/ resolves only by luck of the layout. Resolve
  // it from the workspace that actually declares it.
  const { createRequire } = await import('node:module')
  const requireFromBackend = createRequire(join(REPO_ROOT, 'backend', 'package.json'))
  const pgLib = requireFromBackend('pg')
  const client = new pgLib.Client({ connectionString: DATABASE_URL })
  // The container is usually still starting when this runs.
  for (let i = 0; ; i++) {
    try { await client.connect(); break } catch (err) {
      if (i >= 30) throw err
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  exec = (sql) => client.query(sql)
  q = async (sql) => (await client.query(sql)).rows
  close = () => client.end()
  console.log('checking against real Postgres, hypertables included\n')
} else {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  exec = (sql) => db.exec(sql)
  q = async (sql) => (await db.query(sql)).rows
  close = async () => {}
  console.log('checking against Postgres-in-WASM, no timescaledb\n')
}

/**
 * PGlite ships no timescaledb, and only price_history and prob_snapshots use
 * it. Neither's hypertable-ness is what any migration here changes, so the two
 * statements are dropped for this harness. CI still runs the real image.
 */
const stripTimescale = (sql) =>
  usingRealPg
    ? sql
    : sql
        .replace(/CREATE EXTENSION IF NOT EXISTS timescaledb;/g, '')
        .replace(/SELECT create_hypertable\([^;]*\);/g, '')

const viewDefs = async () =>
  Object.fromEntries(
    (
      await q(`SELECT c.relname AS name, pg_get_viewdef(c.oid, true) AS def
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind = 'v' AND n.nspname = 'public'
                ORDER BY c.relname`)
    ).map((r) => [r.name, r.def]),
  )

const fail = (msg) => {
  console.error(`FAIL ${msg}`)
  process.exitCode = 1
}

const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
let before = null

// Record what was applied, exactly as backend/src/db/migrate.ts does.
//
// Without this the database is left looking unmigrated, and the next process
// to run the real migrator re-applies 001 onward on top of a schema 005 has
// already changed - which fails with "cannot drop columns from view", because
// 003's version of market_usdc_flows has fewer columns than 004's. Found by
// pointing the keeper at a database this script had prepared.
await exec(`CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW()
)`)
const alreadyApplied = new Set((await q('SELECT name FROM _migrations')).map((r) => r.name))

for (const file of files) {
  if (alreadyApplied.has(file)) {
    console.log(`skipped ${file} (already applied)`)
    continue
  }
  if (file === ROUND_TRIP_AT) before = await viewDefs()
  try {
    await exec(stripTimescale(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')))
    await exec(`INSERT INTO _migrations(name) VALUES ('${file}') ON CONFLICT DO NOTHING`)
    console.log(`applied ${file}`)
  } catch (err) {
    fail(`${file}: ${err.message}`)
    process.exit(1)
  }
}

// ── 1. The views came back unchanged ─────────────────────────────────────
if (before) {
  const after = await viewDefs()
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  let drift = 0
  for (const name of names) {
    if (!(name in after)) { fail(`view ${name} was dropped by ${ROUND_TRIP_AT} and never recreated`); drift++ }
    else if (!(name in before)) continue // a genuinely new view is fine
    else if (EXPECTED_FURTHER_CHANGES.has(name)) continue // deliberately changed again, later - see the comment above
    else if (before[name] !== after[name]) {
      fail(`view ${name} changed across ${ROUND_TRIP_AT}`)
      console.error(`  before: ${before[name].replace(/\s+/g, ' ').slice(0, 200)}`)
      console.error(`  after:  ${after[name].replace(/\s+/g, ' ').slice(0, 200)}`)
      drift++
    }
  }
  if (!drift) console.log(`\nviews: ${Object.keys(after).length} identical across ${ROUND_TRIP_AT}`)
} else if (alreadyApplied.has(ROUND_TRIP_AT)) {
  console.log(`\nviews: ${ROUND_TRIP_AT} was already applied, round-trip not re-checked`)
} else {
  fail(`${ROUND_TRIP_AT} not found - the view round-trip was not checked`)
}

// ── 2. No money column left at six decimal places ────────────────────────
const narrow = await q(
  `SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND numeric_scale = 6
    ORDER BY table_name, column_name`,
)
if (narrow.length) {
  fail(`${narrow.length} column(s) still hold six decimal places:`)
  for (const c of narrow) console.error(`  ${c.table_name}.${c.column_name}`)
} else {
  console.log('currency: no column left at six decimal places')
}

// ── 3. The rest of what 005 promised ─────────────────────────────────────
const [closeTime] = await q(
  `SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'markets' AND column_name = 'close_time'`,
)
if (closeTime?.is_nullable !== 'YES') fail('markets.close_time is still NOT NULL')
else console.log('markets.close_time is nullable')

for (const [table, column] of [['markets', 'chain_id'], ['markets', 'token_address']]) {
  const rows = await q(
    `SELECT 1 FROM information_schema.columns WHERE table_name = '${table}' AND column_name = '${column}'`,
  )
  if (!rows.length) fail(`${table}.${column} is missing`)
}

const candidates = await q(`SELECT 1 FROM information_schema.tables WHERE table_name = 'pool_candidates'`)
if (!candidates.length) fail('pool_candidates was not created')
else console.log('pool_candidates exists')

const idx = (await q(`SELECT indexname FROM pg_indexes WHERE tablename = 'markets'`)).map((r) => r.indexname)
if (!idx.includes('idx_markets_feed_id')) fail('idx_markets_feed_id is missing')

// The check the WASM path cannot do: prob_snapshots is a hypertable and 005
// alters two of its columns, so on a real timescale server confirm it is still
// a hypertable and that the widening actually took underneath it.
if (usingRealPg) {
  const ht = await q(`SELECT hypertable_name FROM timescaledb_information.hypertables
                       WHERE hypertable_name = 'prob_snapshots'`)
  if (!ht.length) fail('prob_snapshots stopped being a hypertable')
  else {
    const cols = await q(`SELECT column_name, numeric_scale FROM information_schema.columns
                           WHERE table_name = 'prob_snapshots' AND column_name IN ('up_pool','down_pool')`)
    const bad = cols.filter((c) => Number(c.numeric_scale) !== 18)
    if (bad.length) fail(`hypertable columns not widened: ${bad.map((c) => c.column_name).join(', ')}`)
    else console.log('prob_snapshots is still a hypertable, and its columns widened')
  }
}

await close()

if (process.exitCode) console.error('\nmigration check FAILED')
else console.log('\nmigration check passed')
