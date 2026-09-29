import { describe, it, expect, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readyMatchLagQuery } from './settlementLag'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')
const strip = (sql: string) =>
  sql.replace(/CREATE EXTENSION IF NOT EXISTS timescaledb;/g, '').replace(/SELECT create_hypertable\([^;]*\);/g, '')

const CURRENT = '0x' + 'c'.repeat(40)
const OLD = '0x' + 'd'.repeat(40)

// One migrated database per file, cleared between tests: building it is the slow part.
let shared: Promise<PGlite> | null = null
function migrated(): Promise<PGlite> {
  shared ??= (async () => {
    const db = new PGlite()
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
      await db.exec(strip(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')))
    }
    return db
  })()
  return shared
}
beforeAll(async () => { await migrated() }, 180_000)

async function freshDb() {
  const db = await migrated()
  await db.exec('TRUNCATE TABLE order_matches, matches, orders, markets CASCADE')
  for (const [addr, factory] of [['0xm1', CURRENT], ['0xm2', OLD]] as const) {
    await db.query(
      `INSERT INTO markets(market_address, feed_id, feed_symbol, duration_secs, open_time, factory_address)
       VALUES ($1, '0xfeed', 'T', 300, NOW(), $2)`,
      [addr, factory],
    )
  }
  return db
}

/** A match that came due `dueAgoSec` seconds ago (negative: comes due in the future). */
async function addMatch(db: PGlite, market: string, id: number, dueAgoSec: number, settled = false) {
  await db.query(
    `INSERT INTO matches(market_address, match_id, is_lp_match, amount_usdc, entry_price, matched_at, settle_at, settled)
     VALUES ($1, $2, FALSE, 1, 1, NOW() - INTERVAL '2 hours', NOW() - make_interval(secs => $3), $4)`,
    [market, id, dueAgoSec, settled],
  )
}

const lag = async (db: PGlite, factory: string | null) =>
  Number((await db.query<any>(readyMatchLagQuery(factory))).rows[0].lag)

describe('readyMatchLagQuery', () => {
  it('is 0 when nothing is waiting', async () => {
    const db = await freshDb()
    expect(await lag(db, null)).toBe(0)
  })

  it('reports how long the OLDEST due, unresolved match has waited, from the moment it came due', async () => {
    const db = await freshDb()
    await addMatch(db, '0xm1', 1, 45)
    await addMatch(db, '0xm1', 2, 130) // the oldest one still waiting
    await addMatch(db, '0xm1', 3, 10)
    const l = await lag(db, null)
    // A little slack for the time the query itself takes.
    expect(l).toBeGreaterThanOrEqual(130)
    expect(l).toBeLessThan(140)
  })

  it('sees a match well before stale_settlements would (which needs five minutes)', async () => {
    const db = await freshDb()
    await addMatch(db, '0xm1', 1, 100)
    expect(await lag(db, null)).toBeGreaterThanOrEqual(100)
    const stale = (await db.query<any>(`SELECT COUNT(*)::int AS n FROM stale_settlements`)).rows[0].n
    expect(stale).toBe(0)
  })

  it('ignores matches that are settled, not due yet, or past the grace window', async () => {
    const db = await freshDb()
    await addMatch(db, '0xm1', 1, 600, true)          // settled
    await addMatch(db, '0xm1', 2, -300)               // due in five minutes
    await addMatch(db, '0xm1', 3, 26 * 3600)          // 26 hours: emergencyRefundMatch's, not this
    expect(await lag(db, null)).toBe(0)
  })

  it('on rhc counts only the current factory: an earlier deployment is not a lag', async () => {
    const db = await freshDb()
    await addMatch(db, '0xm2', 1, 5000) // stuck on the old factory
    await addMatch(db, '0xm1', 1, 20)
    expect(await lag(db, CURRENT)).toBeLessThan(30)
    // Unscoped (base) it would see the old one.
    expect(await lag(db, null)).toBeGreaterThanOrEqual(5000)
  })
})
