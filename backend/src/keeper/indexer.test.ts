import { describe, it, expect, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processLog, applyMatchTied, insertMarketRow, type TxPool } from './indexer'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')

// PGlite ships no timescaledb; neither statement is relevant to anything
// these tests touch (price_history / prob_snapshots). Same approach as
// scripts/check-migrations.mjs.
function stripTimescale(sql: string): string {
  return sql
    .replace(/CREATE EXTENSION IF NOT EXISTS timescaledb;/g, '')
    .replace(/SELECT create_hypertable\([^;]*\);/g, '')
}

/**
 * One migrated database per file. Building a Postgres in WASM and running every
 * migration is the slow part (seconds, and far more on a busy machine, where it
 * used to push individual tests past their timeout); each test starts from
 * emptied tables instead.
 */
let shared: Promise<PGlite> | null = null
function migrated(): Promise<PGlite> {
  shared ??= (async () => {
    const db = new PGlite()
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    for (const file of files) {
      await db.exec(stripTimescale(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')))
    }
    return db
  })()
  return shared
}
beforeAll(async () => { await migrated() }, 180_000)

/** A migrated Postgres-in-WASM instance with empty tables, wrapped as a TxPool. */
async function freshDb(): Promise<{ db: PGlite; pool: TxPool }> {
  const db = await migrated()
  await db.exec('TRUNCATE TABLE referrals, order_matches, matches, orders, markets, _ingested_logs CASCADE')
  const pool: TxPool = {
    async connect() {
      return {
        query: (sql: string, params?: any[]) => db.query(sql, params) as any,
        release: () => {},
      }
    },
  }
  return { db, pool }
}

async function insertOrder(
  db: PGlite,
  o: { market: string; orderId: number; status: string; unmatchedRefunded?: boolean },
) {
  await db.query(
    `INSERT INTO orders(market_address, order_id, trader_address, direction, amount_usdc, status, placed_at, feed_symbol, unmatched_refunded)
     VALUES ($1, $2, '0xtrader', 'UP', 1, $3, NOW(), 'TEST', $4)`,
    [o.market, o.orderId, o.status, o.unmatchedRefunded ?? false],
  )
}

async function insertMatch(db: PGlite, m: { market: string; matchId: number; settled?: boolean }) {
  await db.query(
    `INSERT INTO matches(market_address, match_id, is_lp_match, amount_usdc, entry_price, matched_at, settle_at, settled)
     VALUES ($1, $2, FALSE, 1, 1, NOW(), NOW(), $3)`,
    [m.market, m.matchId, m.settled ?? false],
  )
}

async function linkOrderMatch(db: PGlite, market: string, orderId: number, matchId: number) {
  await db.query(
    `INSERT INTO order_matches(market_address, order_id, match_id, matched_amount) VALUES ($1, $2, $3, 1)`,
    [market, orderId, matchId],
  )
}

async function statusOf(db: PGlite, orderId: number): Promise<string> {
  const r = await db.query<{ status: string }>(`SELECT status FROM orders WHERE order_id = $1`, [orderId])
  return r.rows[0].status
}

describe('applyMatchTied (audit A01, 2026-09-28)', () => {
  it('does not close out an unrelated pending order that has no matches at all', async () => {
    const { db, pool } = await freshDb()
    const market = '0xmarket'

    await insertOrder(db, { market, orderId: 1, status: 'MATCHED' }) // participant, fully filled
    await insertOrder(db, { market, orderId: 2, status: 'PENDING' }) // unrelated: no matches at all
    await insertMatch(db, { market, matchId: 1 })
    await linkOrderMatch(db, market, 1, 1)

    const tx = await pool.connect()
    await applyMatchTied(tx, market, '1', '1000000000000000000', Math.floor(Date.now() / 1000))
    tx.release()

    // This is the exact bug: order 2 has no match at all, so a market-wide
    // "no unsettled match of its own" sweep used to promote it too.
    expect(await statusOf(db, 2)).toBe('PENDING')
    expect(await statusOf(db, 1)).toBe('SETTLED')
  })

  it('leaves a partially-filled order alone while its unmatched remainder is still live', async () => {
    const { db, pool } = await freshDb()
    const market = '0xmarket'

    // order 3 is a real participant of match 1 (via order_matches), but it
    // also still has an unmatched remainder resting in the book (status
    // PENDING, unmatched_refunded still false) - a tie on the piece that DID
    // match must not close out the piece that hasn't.
    await insertOrder(db, { market, orderId: 3, status: 'PENDING' })
    await insertMatch(db, { market, matchId: 1 })
    await linkOrderMatch(db, market, 3, 1)

    const tx = await pool.connect()
    await applyMatchTied(tx, market, '1', '1', Math.floor(Date.now() / 1000))
    tx.release()

    expect(await statusOf(db, 3)).toBe('PENDING')
  })

  it('promotes a participant once its unmatched remainder was already refunded', async () => {
    const { db, pool } = await freshDb()
    const market = '0xmarket'

    await insertOrder(db, { market, orderId: 5, status: 'PENDING', unmatchedRefunded: true })
    await insertMatch(db, { market, matchId: 9 })
    await linkOrderMatch(db, market, 5, 9)

    const tx = await pool.connect()
    await applyMatchTied(tx, market, '9', '1', Math.floor(Date.now() / 1000))
    tx.release()

    expect(await statusOf(db, 5)).toBe('SETTLED')
  })

  it('does not promote a participant that still has a different match unsettled', async () => {
    const { db, pool } = await freshDb()
    const market = '0xmarket'

    await insertOrder(db, { market, orderId: 7, status: 'MATCHED' })
    await insertMatch(db, { market, matchId: 1 })
    await insertMatch(db, { market, matchId: 2, settled: false })
    await linkOrderMatch(db, market, 7, 1)
    await linkOrderMatch(db, market, 7, 2)

    const tx = await pool.connect()
    await applyMatchTied(tx, market, '1', '1', Math.floor(Date.now() / 1000))
    tx.release()

    expect(await statusOf(db, 7)).toBe('MATCHED')
  })

  it('marks the match itself settled and tied, with the tie price recorded', async () => {
    const { db, pool } = await freshDb()
    const market = '0xmarket'
    await insertMatch(db, { market, matchId: 1 })

    const tx = await pool.connect()
    await applyMatchTied(tx, market, '1', '2500000000000000000', 1_800_000_000)
    tx.release()

    const r = await db.query<{ settled: boolean; tied: boolean; exit_price: string }>(
      `SELECT settled, tied, exit_price FROM matches WHERE match_id = 1`,
    )
    expect(r.rows[0].settled).toBe(true)
    expect(r.rows[0].tied).toBe(true)
    expect(Number(r.rows[0].exit_price)).toBe(2.5e18)
  })
})

describe('processLog (audit A02, 2026-09-28)', () => {
  it('commits the dedup row and the handler write together', async () => {
    const { db, pool } = await freshDb()
    await processLog(pool, { transactionHash: '0xabc', logIndex: 0 }, async (tx) => {
      await tx.query(`INSERT INTO referrals(referrer_address, referee_address) VALUES ('0xref', '0xreferee')`)
    })

    const ingested = await db.query(`SELECT 1 FROM _ingested_logs WHERE tx_hash = '0xabc' AND log_index = 0`)
    expect(ingested.rows.length).toBe(1)
    const referral = await db.query(`SELECT 1 FROM referrals WHERE referrer_address = '0xref'`)
    expect(referral.rows.length).toBe(1)
  })

  it('rolls back the dedup row together with the handler write on failure, so a retry redoes both', async () => {
    const { db, pool } = await freshDb()
    let attempts = 0
    const run = () =>
      processLog(pool, { transactionHash: '0xdef', logIndex: 0 }, async (tx) => {
        attempts++
        await tx.query(`INSERT INTO referrals(referrer_address, referee_address) VALUES ('0xref2', '0xreferee2')`)
        if (attempts === 1) throw new Error('simulated failure after the write')
      })

    await expect(run()).rejects.toThrow('simulated failure')

    // This is the bug: before A02, the dedup insert ran on its own via the
    // pool and had already committed by the time the write below it failed -
    // a retry would see the log as already seen and skip it forever, having
    // never actually written the referral.
    expect((await db.query(`SELECT 1 FROM _ingested_logs WHERE tx_hash = '0xdef'`)).rows.length).toBe(0)
    expect((await db.query(`SELECT 1 FROM referrals WHERE referrer_address = '0xref2'`)).rows.length).toBe(0)

    await run() // retry: the log still looks new, so this time it goes through
    expect((await db.query(`SELECT 1 FROM _ingested_logs WHERE tx_hash = '0xdef'`)).rows.length).toBe(1)
    expect((await db.query(`SELECT 1 FROM referrals WHERE referrer_address = '0xref2'`)).rows.length).toBe(1)
  })

  it('skips a log whose dedup row already exists, without running the handler', async () => {
    const { db, pool } = await freshDb()
    await db.query(`INSERT INTO _ingested_logs(tx_hash, log_index) VALUES ('0xseen', 0)`)

    let called = false
    await processLog(pool, { transactionHash: '0xseen', logIndex: 0 }, async () => {
      called = true
    })

    expect(called).toBe(false)
  })
})

describe('insertMarketRow (factory stamp, migration 008)', () => {
  const CHECKSUMMED = '0xC52b8b69d266F9656Be11511907192EaFD521BcB'
  const row = (over: Record<string, unknown> = {}) => ({
    market: '0xDc4e0000000000000000000000000000000000AA',
    feedId: '0x' + '11'.repeat(32),
    symbol: 'PEPE',
    duration: 300,
    openedAt: 1_800_000_000,
    closeAt: null,
    chainId: 46630,
    token: '0xtoken',
    factory: CHECKSUMMED,
    ...over,
  })

  it('stamps the factory that announced the market, lower-cased like every address the queries compare', async () => {
    const { db, pool } = await freshDb()
    const tx = await pool.connect()
    await insertMarketRow(tx, row())
    tx.release()

    const r = await db.query<any>(`SELECT market_address, factory_address, close_time, chain_id FROM markets`)
    expect(r.rows[0].factory_address).toBe(CHECKSUMMED.toLowerCase())
    expect(r.rows[0].market_address).toBe('0xdc4e0000000000000000000000000000000000aa')
    expect(r.rows[0].close_time).toBeNull() // rhc: a market has no close time
    expect(r.rows[0].chain_id).toBe(46630)
  })

  it('stores null when it was not told a factory, so the row reads as "not current" on rhc', async () => {
    const { db, pool } = await freshDb()
    const tx = await pool.connect()
    await insertMarketRow(tx, row({ factory: null }))
    tx.release()
    expect((await db.query<any>(`SELECT factory_address FROM markets`)).rows[0].factory_address).toBeNull()
  })

  it('does not restamp a row it already has: a replay changes nothing', async () => {
    const { db, pool } = await freshDb()
    const tx = await pool.connect()
    await insertMarketRow(tx, row())
    await insertMarketRow(tx, row({ factory: '0x' + 'e'.repeat(40) }))
    tx.release()
    const r = await db.query<any>(`SELECT factory_address FROM markets`)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].factory_address).toBe(CHECKSUMMED.toLowerCase())
  })

  it('leaves what migration 008 found alone: existing rows keep NULL', async () => {
    const { db } = await freshDb()
    // A row written the way the indexer did before the column existed.
    await db.query(
      `INSERT INTO markets(market_address, feed_id, feed_symbol, duration_secs, open_time)
       VALUES ('0xold', '0xfeed', 'OLD', 300, NOW())`,
    )
    expect((await db.query<any>(`SELECT factory_address FROM markets`)).rows[0].factory_address).toBeNull()
  })
})
