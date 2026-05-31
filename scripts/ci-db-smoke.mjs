#!/usr/bin/env node
/**
 * CI DB smoke test:
 *   1. Connect to the DATABASE_URL provided by the workflow service container.
 *   2. Apply every backend/src/db/migrations/*.sql file in order.
 *   3. Assert all expected tables exist.
 *
 * Fails the CI job if any migration has a syntax error (e.g. the regression we
 * just fixed: `CREATE TABLE IF NOT EXISTSprice_history`).
 *
 * Usage (CI):
 *   DATABASE_URL=postgres://... node scripts/ci-db-smoke.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'backend', 'src', 'db', 'migrations')

const EXPECTED_TABLES = [
  'price_history',
  'markets',
  'bets',
  'referrals',
  'ref_codes',
  'referral_earnings',
  'prob_snapshots',
  'trader_streaks',
  'minted_badges',
]

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL not set')
  process.exit(2)
}

const client = new pg.Client({ connectionString: url })

try {
  await client.connect()
  console.log('connected to', url.replace(/:[^:@]*@/, ':***@'))

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  if (files.length === 0) {
    console.error('no migrations found in', MIGRATIONS_DIR)
    process.exit(3)
  }

  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
    console.log(`applying ${f} …`)
    await client.query(sql)
  }

  const { rows } = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `)
  const present = new Set(rows.map((r) => r.table_name))

  const missing = EXPECTED_TABLES.filter((t) => !present.has(t))
  if (missing.length > 0) {
    console.error('missing tables:', missing.join(', '))
    process.exit(4)
  }

  console.log('OK — all expected tables present:', EXPECTED_TABLES.join(', '))
} catch (err) {
  console.error('migration smoke failed:', err.message)
  process.exit(1)
} finally {
  await client.end().catch(() => {})
}
