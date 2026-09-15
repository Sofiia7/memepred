import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname }          from 'node:path'
import { fileURLToPath }             from 'node:url'
import { pg }                        from './pg.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = resolve(__dirname, 'migrations')

/**
 * Arbitrary constant, unique to this project's migration lock. Postgres
 * advisory locks are a single global 64-bit-keyed namespace per database, so
 * this only has to not collide with whatever else in this codebase might
 * ever take one - nothing else does today.
 */
const MIGRATION_LOCK_KEY = 78_612_045_501n

/**
 * Idempotent runner — tracks applied migrations in `_migrations` table.
 * Add new files as 002_*.sql, 003_*.sql, etc. — they execute in name order.
 *
 * Runs on a single checked-out client, not `pg.query()` directly. `pg` is a
 * Pool: each `pool.query()` call checks out whichever client happens to be
 * free, so a previous version of this function that ran BEGIN, the
 * migration's SQL, and COMMIT as three separate `pg.query()` calls could
 * have them land on three DIFFERENT connections - meaning the "transaction"
 * was never actually one, and a failure partway through a multi-statement
 * migration left whatever had already run applied with no way to roll it
 * back, while `_migrations` might still say "not applied" and the next
 * start would retry it against a database that already has part of it.
 *
 * The whole run is also wrapped in a Postgres advisory lock, so the API and
 * the keeper starting at the same moment against a fresh database - or any
 * other case of two processes calling this concurrently - serialise instead
 * of racing the same CREATE TABLE / ALTER TABLE.
 */
export async function runMigrations() {
  const client = await pg.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
          name        TEXT PRIMARY KEY,
          applied_at  TIMESTAMPTZ DEFAULT NOW()
        )
      `)

      const applied = await client.query('SELECT name FROM _migrations')
      const done    = new Set(applied.rows.map((r) => r.name))

      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort()

      for (const file of files) {
        if (done.has(file)) continue
        const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8')
        console.log(`Applying migration ${file}…`)
        await client.query('BEGIN')
        try {
          await client.query(sql)
          await client.query('INSERT INTO _migrations(name) VALUES ($1)', [file])
          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK')
          throw err
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
    }
  } finally {
    client.release()
  }
}
