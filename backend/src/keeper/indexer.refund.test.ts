import { describe, it, expect, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  processMarketLogs,
  type IndexedLog,
  type MarketLogDeps,
  type OnChainOrder,
  type TxClient,
  type TxPool,
  type Queryable,
} from './indexer'
import { PoisonTracker, type PoisonRecord } from './poisonTracker'

/**
 * MatchRefunded and the refund logs around it, run through the real chunk
 * handler against a real (WASM) Postgres with the real migrations.
 *
 * The contract emits, for one refunded match, in one transaction:
 *   OrderRefunded(each side, matched amount), OrderRefunded(unmatched tail,
 *   when a side had one), MatchRefunded(matchId).
 * Before the handler existed the generic OrderRefunded path treated the first
 * of those as "the unmatched remainder came back" and set unmatched_refunded on
 * an order that was fully filled.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')

function stripTimescale(sql: string): string {
  return sql
    .replace(/CREATE EXTENSION IF NOT EXISTS timescaledb;/g, '')
    .replace(/SELECT create_hypertable\([^;]*\);/g, '')
}

const MARKET = '0x00000000000000000000000000000000000000aa'
const TS = 1_800_000_000
const ONE = 1_000_000n // one unit of the base profile's 6-decimal stake currency

/**
 * One migrated database per file, cleared between tests. Building a Postgres in
 * WASM and running every migration is the expensive part (seconds, and much
 * more on a busy machine), and paying it per test is what made this file time
 * out under load; emptying the tables is not.
 */
let shared: Promise<PGlite> | null = null
function migrated(): Promise<PGlite> {
  shared ??= (async () => {
    const db = new PGlite()
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    for (const file of files) await db.exec(stripTimescale(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')))
    return db
  })()
  return shared
}

beforeAll(async () => { await migrated() }, 180_000)

async function freshDb(): Promise<{ db: PGlite; pool: TxPool & Queryable }> {
  const db = await migrated()
  await db.exec('TRUNCATE TABLE order_matches, matches, orders, markets, _ingested_logs CASCADE')
  await db.query(
    `INSERT INTO markets(market_address, feed_id, feed_symbol, duration_secs, open_time, close_time)
     VALUES ($1, '0xfeed', 'TEST', 300, NOW(), NOW() + INTERVAL '1 hour')`,
    [MARKET],
  )
  const query = (sql: string, params?: any[]) => db.query(sql, params) as any
  const pool: TxPool & Queryable = {
    async connect() {
      const client: TxClient & { release(): void } = { query, release: () => {} }
      return client
    },
    query,
  }
  return { db, pool }
}

/** A scripted chain: what getOrder would answer for each order. */
function chain(orders: Record<string, OnChainOrder>) {
  const reads: string[] = []
  const readOrder = async (market: string, orderId: string): Promise<OnChainOrder> => {
    reads.push(`${market}:${orderId}`)
    const o = orders[orderId]
    if (!o) throw new Error(`no scripted order ${orderId}`)
    return o
  }
  return { readOrder, reads }
}

const REFUNDED: OnChainOrder = { status: 4, payout: 0n, unmatchedRefunded: false }

let idx = 0
function log(eventName: string, args: Record<string, unknown>, tx = '0xtx1', block = 100n): IndexedLog {
  return { address: MARKET, blockNumber: block, transactionHash: tx, logIndex: idx++, eventName, args }
}
const placed = (orderId: number, dir: 0 | 1, amount: bigint, tx = '0xplace') =>
  log('OrderPlaced', { orderId: BigInt(orderId), trader: '0x00000000000000000000000000000000000000b1', dir, amount }, tx)
const matchedLog = (matchId: number, upId: number, downId: number, amount: bigint, tx = '0xmatch') =>
  log('OrderMatched', { matchId: BigInt(matchId), upId: BigInt(upId), downId: BigInt(downId), amount, entryPrice: 10n ** 18n }, tx)
const lpMatchedLog = (matchId: number, orderId: number, amount: bigint, tx = '0xmatch') =>
  log('LPMatched', { matchId: BigInt(matchId), orderId: BigInt(orderId), amount, entryPrice: 10n ** 18n }, tx)
const filledLog = (orderId: number, total: bigint, tx = '0xmatch') =>
  log('OrderFilled', { orderId: BigInt(orderId), totalFilled: total }, tx)
const orderRefunded = (orderId: number, amount: bigint, tx: string) =>
  log('OrderRefunded', { orderId: BigInt(orderId), trader: '0x00000000000000000000000000000000000000b1', amount }, tx, 105n)
const matchRefunded = (matchId: number, tx: string) =>
  log('MatchRefunded', { matchId: BigInt(matchId) }, tx, 105n)

function deps(pool: TxPool & Queryable, readOrder: MarketLogDeps['readOrder'], extra: Partial<MarketLogDeps> = {}): MarketLogDeps {
  return { db: pool, blockTs: async () => TS, readOrder, ...extra }
}

async function order(db: PGlite, id: number) {
  const r = await db.query<any>(
    `SELECT status, unmatched_refunded, payout_usdc, refunded_at, filled_amount FROM orders WHERE order_id = $1`,
    [id],
  )
  return r.rows[0]
}
async function match(db: PGlite, id: number) {
  const r = await db.query<any>(
    `SELECT settled, emergency_refunded, tied, settled_at, exit_price FROM matches WHERE match_id = $1`,
    [id],
  )
  return r.rows[0]
}

describe('MatchRefunded (audit follow-up 2026-09-28, P2)', () => {
  it('closes a refunded PvP match promptly and leaves fully filled orders without an unmatched refund', async () => {
    const { db, pool } = await freshDb()
    const { readOrder } = chain({ 1: REFUNDED, 2: REFUNDED })

    await processMarketLogs([
      placed(1, 0, ONE), placed(2, 1, ONE),
      matchedLog(1, 1, 2, ONE), filledLog(1, ONE), filledLog(2, ONE),
      // The refund transaction, as the contract emits it.
      orderRefunded(1, ONE, '0xrefund'), orderRefunded(2, ONE, '0xrefund'), matchRefunded(1, '0xrefund'),
    ], deps(pool, readOrder))

    const m = await match(db, 1)
    expect(m.settled).toBe(true)
    expect(m.emergency_refunded).toBe(true)
    expect(m.tied).toBe(false)
    expect(m.settled_at).not.toBeNull()

    for (const id of [1, 2]) {
      const o = await order(db, id)
      expect(o.status).toBe('REFUNDED')
      // The whole matched stake came back. Nothing was "unmatched", which is
      // exactly what the generic OrderRefunded path would have claimed.
      expect(o.unmatched_refunded).toBe(false)
      expect(Number(o.payout_usdc)).toBe(0)
      expect(o.refunded_at).not.toBeNull()
    }
  })

  it('closes a refunded LP match the same way', async () => {
    const { db, pool } = await freshDb()
    const { readOrder } = chain({ 1: REFUNDED })

    await processMarketLogs([
      placed(1, 0, ONE),
      lpMatchedLog(1, 1, ONE), filledLog(1, ONE),
      orderRefunded(1, ONE, '0xrefund'), matchRefunded(1, '0xrefund'),
    ], deps(pool, readOrder))

    const m = await match(db, 1)
    expect(m.settled).toBe(true)
    expect(m.emergency_refunded).toBe(true)
    const o = await order(db, 1)
    expect(o.status).toBe('REFUNDED')
    expect(o.unmatched_refunded).toBe(false)
  })

  it('takes the unmatched tail from the chain for a partially filled order', async () => {
    const { db, pool } = await freshDb()
    // Order 1 wanted 2, got 1; its tail of 1 was handed back in the SAME
    // transaction as the match refund. Order 3 is an unrelated resting order
    // whose own genuine refund rides in that transaction too.
    const { readOrder } = chain({
      1: { status: 4, payout: 0n, unmatchedRefunded: true },
      2: REFUNDED,
    })

    await processMarketLogs([
      placed(1, 0, 2n * ONE), placed(2, 1, ONE), placed(3, 0, ONE),
      matchedLog(1, 1, 2, ONE), filledLog(2, ONE),
      orderRefunded(1, ONE, '0xrefund'),      // matched amount, side 1
      orderRefunded(2, ONE, '0xrefund'),      // matched amount, side 2
      orderRefunded(1, ONE, '0xrefund'),      // side 1's unmatched tail
      orderRefunded(3, ONE, '0xrefund'),      // unrelated order, genuinely unmatched
      matchRefunded(1, '0xrefund'),
    ], deps(pool, readOrder))

    const o1 = await order(db, 1)
    expect(o1.status).toBe('REFUNDED')
    expect(o1.unmatched_refunded).toBe(true) // from the chain: the tail did come back
    const o2 = await order(db, 2)
    expect(o2.status).toBe('REFUNDED')
    expect(o2.unmatched_refunded).toBe(false)

    // The unrelated order is NOT a participant, so the generic handler still owns it.
    const o3 = await order(db, 3)
    expect(o3.unmatched_refunded).toBe(true)
    expect(o3.status).toBe('REFUNDED')
  })

  it('keeps winnings that another match already accrued, as the chain reports them', async () => {
    const { db, pool } = await freshDb()
    // Order 1 has two matches; match 1 is refunded and match 2 already won.
    // The contract forces the order to REFUNDED but leaves the payout accrued.
    const { readOrder } = chain({
      1: { status: 4, payout: 3n * ONE, unmatchedRefunded: false },
      2: REFUNDED,
    })

    await processMarketLogs([
      placed(1, 0, 2n * ONE), placed(2, 1, ONE), placed(3, 1, ONE),
      matchedLog(1, 1, 2, ONE), matchedLog(2, 1, 3, ONE), filledLog(1, 2n * ONE),
      orderRefunded(1, ONE, '0xrefund'), orderRefunded(2, ONE, '0xrefund'), matchRefunded(1, '0xrefund'),
    ], deps(pool, readOrder))

    expect((await match(db, 1)).settled).toBe(true)
    expect((await match(db, 2)).settled).toBe(false) // the other match is untouched
    expect(Number((await order(db, 1)).payout_usdc)).toBe(3)
  })

  it('sees a match created and refunded in the same chunk, whatever order the logs arrive in', async () => {
    const { db, pool } = await freshDb()
    const { readOrder } = chain({ 1: REFUNDED, 2: REFUNDED })

    // Deliberately reversed: the handler partitions by event, so the creation
    // rows exist before anything reads order_matches.
    await processMarketLogs([
      matchRefunded(1, '0xrefund'), orderRefunded(2, ONE, '0xrefund'), orderRefunded(1, ONE, '0xrefund'),
      filledLog(2, ONE), filledLog(1, ONE), matchedLog(1, 1, 2, ONE), placed(2, 1, ONE), placed(1, 0, ONE),
    ], deps(pool, readOrder))

    expect((await match(db, 1)).settled).toBe(true)
    expect((await order(db, 1)).unmatched_refunded).toBe(false)
    expect((await order(db, 2)).status).toBe('REFUNDED')
  })

  it('is idempotent: a replayed chunk changes nothing, and does not read the chain into the rows twice', async () => {
    const { db, pool } = await freshDb()
    const logs = [
      placed(1, 0, ONE), placed(2, 1, ONE),
      matchedLog(1, 1, 2, ONE), filledLog(1, ONE), filledLog(2, ONE),
      orderRefunded(1, ONE, '0xrefund'), orderRefunded(2, ONE, '0xrefund'), matchRefunded(1, '0xrefund'),
    ]

    await processMarketLogs(logs, deps(pool, chain({ 1: REFUNDED, 2: REFUNDED }).readOrder))
    const before = { m: await match(db, 1), o1: await order(db, 1), o2: await order(db, 2) }
    const ingested = (await db.query<any>(`SELECT COUNT(*)::int AS n FROM _ingested_logs`)).rows[0].n

    // The chain has moved on since (a payout accrued elsewhere). A replay must
    // still not rewrite the rows the first pass wrote: the log is already ingested.
    await processMarketLogs(logs, deps(pool, chain({
      1: { status: 4, payout: 9n * ONE, unmatchedRefunded: true },
      2: REFUNDED,
    }).readOrder))

    expect(await match(db, 1)).toEqual(before.m)
    expect(await order(db, 1)).toEqual(before.o1)
    expect(await order(db, 2)).toEqual(before.o2)
    expect((await db.query<any>(`SELECT COUNT(*)::int AS n FROM _ingested_logs`)).rows[0].n).toBe(ingested)
  })

  it('still handles a tie exactly as before, now keyed by transaction', async () => {
    const { db, pool } = await freshDb()
    const { readOrder } = chain({})

    await processMarketLogs([
      placed(1, 0, ONE), placed(2, 1, ONE),
      matchedLog(1, 1, 2, ONE), filledLog(1, ONE), filledLog(2, ONE),
      orderRefunded(1, ONE, '0xtie'), orderRefunded(2, ONE, '0xtie'),
      log('MatchTied', { matchId: 1n, price: 10n ** 18n }, '0xtie', 105n),
    ], deps(pool, readOrder))

    expect((await match(db, 1)).tied).toBe(true)
    for (const id of [1, 2]) {
      const o = await order(db, id)
      expect(o.status).toBe('SETTLED')
      expect(o.unmatched_refunded).toBe(false)
    }
  })

  it('does not swallow a refund of the same order that arrives in a different transaction', async () => {
    const { db, pool } = await freshDb()
    const { readOrder } = chain({ 1: REFUNDED, 2: REFUNDED })

    // Order 1 is a participant of match 1 (refunded in 0xrefund). Later, in
    // another transaction, a cancel returns a remainder it still had resting.
    await processMarketLogs([
      placed(1, 0, 2n * ONE), placed(2, 1, ONE),
      matchedLog(1, 1, 2, ONE),
      orderRefunded(1, ONE, '0xrefund'), orderRefunded(2, ONE, '0xrefund'), matchRefunded(1, '0xrefund'),
      orderRefunded(1, ONE, '0xcancel'),
    ], deps(pool, readOrder))

    // The chain read in the match handler said "no tail refunded yet"; the
    // separate refund transaction is what marks it.
    expect((await order(db, 1)).unmatched_refunded).toBe(true)
  })
})

describe('poison log visibility wired into processMarketLogs', () => {
  function tracker() {
    const published: PoisonRecord[] = []
    let cleared = 0
    const lines: string[] = []
    const t = new PoisonTracker(
      { publish: async (r) => { published.push(r) }, clear: async () => { cleared++ } },
      { log: (l) => lines.push(l), now: () => 1_000 },
    )
    return { t, published, lines, cleared: () => cleared }
  }

  it('counts the same failing log across ticks, flags it after three, and clears when it finally goes through', async () => {
    const { db, pool } = await freshDb()
    const { t, published, lines, cleared } = tracker()

    let broken = true
    const readOrder = async (_m: string, id: string): Promise<OnChainOrder> => {
      if (broken) throw new Error('getOrder decode failed\nat 0xsomewhere')
      return REFUNDED
    }
    const logs = () => [
      placed(1, 0, ONE), placed(2, 1, ONE),
      matchedLog(1, 1, 2, ONE),
      orderRefunded(1, ONE, '0xrefund'), orderRefunded(2, ONE, '0xrefund'), matchRefunded(1, '0xrefund'),
    ]

    // Same log objects every tick, as a re-fetched chunk would have.
    const fixed = logs()
    for (let tick = 1; tick <= 3; tick++) {
      await expect(processMarketLogs(fixed, deps(pool, readOrder, { poison: t }))).rejects.toThrow('getOrder decode failed')
      expect(t.failures).toBe(tick)
      // Nothing is published until it is clearly a stall, and only one line
      // of the error ever reaches the record.
      expect(published.length).toBe(tick < 3 ? 0 : 1)
    }
    const rec = published[0]
    expect(rec.txHash).toBe('0xrefund')
    expect(rec.event).toBe('MatchRefunded')
    expect(rec.market).toBe(MARKET)
    expect(rec.failures).toBe(3)
    expect(rec.error).toBe('getOrder decode failed')
    expect(lines.some((l) => l.includes('CRITICAL'))).toBe(true)

    // Not skipped: the match is still unsettled in the projection.
    expect((await match(db, 1)).settled).toBe(false)

    broken = false
    await processMarketLogs(fixed, deps(pool, readOrder, { poison: t }))
    expect(t.failures).toBe(0)
    expect(cleared()).toBe(1)
    expect((await match(db, 1)).settled).toBe(true)
  })
})
