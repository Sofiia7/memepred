import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname }          from 'node:path'
import { fileURLToPath }             from 'node:url'
import { pg }                        from './pg.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = resolve(__dirname, 'migrations')

/**
 * Idempotent runner — tracks applied migrations in `_migrations` table.
 * Add new files as 002_*.sql, 003_*.sql, etc. — they execute in name order.
 */
export async function runMigrations() {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  const applied = await pg.query('SELECT name FROM _migrations')
  const done    = new Set(applied.rows.map(r => r.name))

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    if (done.has(file)) continue
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8')
    console.log(`Applying migration ${file}…`)
    await pg.query('BEGIN')
    try {
      await pg.query(sql)
      await pg.query('INSERT INTO _migrations(name) VALUES ($1)', [file])
      await pg.query('COMMIT')
    } catch (err) {
      await pg.query('ROLLBACK')
      throw err
    }
  }
}
