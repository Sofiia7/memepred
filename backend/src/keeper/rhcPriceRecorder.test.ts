import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRhcPoolPrices, FeedBackoff, MAX_BACKOFF_TICKS, currentFeedsQuery } from './rhcPriceRecorder'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetchRhcPoolPrices (audit A07, 2026-09-28)', () => {
  it('reads every pool and returns its price', async () => {
    const feeds = [
      { feedId: '0xpool1', symbol: 'PEPE' },
      { feedId: '0xpool2', symbol: 'WIF' },
    ]
    const prices: Record<string, bigint> = { '0xpool1': 1_000_000_000_000_000_000n, '0xpool2': 42n }

    const result = await fetchRhcPoolPrices(feeds, async (feedId) => prices[feedId])

    expect(result).toEqual([
      { feedId: '0xpool1', symbol: 'PEPE', price: 1_000_000_000_000_000_000n },
      { feedId: '0xpool2', symbol: 'WIF', price: 42n },
    ])
  })

  it('skips a pool whose read reverts without losing the others', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const feeds = [
      { feedId: '0xdead', symbol: 'DEADPOOL' },
      { feedId: '0xalive', symbol: 'ALIVE' },
    ]

    const result = await fetchRhcPoolPrices(feeds, async (feedId) => {
      if (feedId === '0xdead') throw new Error('pool has no liquidity')
      return 5n
    })

    expect(result).toEqual([{ feedId: '0xalive', symbol: 'ALIVE', price: 5n }])
  })

  it('returns nothing for an empty pool list rather than erroring', async () => {
    const result = await fetchRhcPoolPrices([], async () => {
      throw new Error('should never be called')
    })
    expect(result).toEqual([])
  })
})

describe('failure logging', () => {
  /** What viem throws: a short message plus a multi-line message carrying the whole request. */
  function viemError() {
    return Object.assign(new Error('The contract function "spotPriceWad" reverted.\n\nContract Call:\n  address: 0x...\n  args: (0x...)\n\nVersion: viem@2'), {
      shortMessage: 'The contract function "spotPriceWad" reverted with the following reason: pool has no liquidity',
    })
  }

  it('writes one short line per failed pool, not the whole error object', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await fetchRhcPoolPrices([{ feedId: '0xpool', symbol: 'PEPE' }], async () => { throw viemError() })

    expect(spy).toHaveBeenCalledTimes(1)
    // A single string argument: passing the error as a second argument is what
    // printed sixty lines a pool.
    expect(spy.mock.calls[0]).toHaveLength(1)
    const line = String(spy.mock.calls[0][0])
    expect(line).toContain('0xpool')
    expect(line).toContain('pool has no liquidity')
    expect(line).not.toContain('\n')
    expect(line).not.toContain('Contract Call')
  })
})

describe('FeedBackoff', () => {
  it('waits twice as long after each consecutive failure, up to the cap', () => {
    const b = new FeedBackoff()
    const waits = [1, 2, 3, 4, 5, 6, 7].map(() => b.failed('0xpool').skipTicks)
    expect(waits).toEqual([2, 4, 8, 16, MAX_BACKOFF_TICKS, MAX_BACKOFF_TICKS, MAX_BACKOFF_TICKS])
    // Thirty-second ticks: the cap is ten minutes.
    expect(MAX_BACKOFF_TICKS * 30).toBe(600)
  })

  it('skips exactly the waited ticks and then lets the read through', () => {
    const b = new FeedBackoff()
    b.failed('0xpool') // wait 2
    expect([b.shouldSkip('0xpool'), b.shouldSkip('0xpool'), b.shouldSkip('0xpool')]).toEqual([true, true, false])
  })

  it('forgets everything on one success', () => {
    const b = new FeedBackoff()
    b.failed('0xpool')
    b.failed('0xpool')
    expect(b.succeeded('0xpool')).toBe(2)
    expect(b.shouldSkip('0xpool')).toBe(false)
    expect(b.failed('0xpool').skipTicks).toBe(2) // the streak started over
  })

  it('keeps feeds independent of each other', () => {
    const b = new FeedBackoff()
    b.failed('0xa')
    expect(b.shouldSkip('0xb')).toBe(false)
  })
})

describe('fetchRhcPoolPrices with a backoff', () => {
  it('stops polling a pool that keeps reverting, retries on the schedule, and never records a price for the gap', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const b = new FeedBackoff()
    const calls: Record<string, number> = { '0xdead': 0, '0xalive': 0 }
    const read = async (feedId: string) => {
      calls[feedId]++
      if (feedId === '0xdead') throw new Error('pool has no liquidity')
      return 7n
    }
    const feeds = [{ feedId: '0xdead', symbol: 'DEAD' }, { feedId: '0xalive', symbol: 'ALIVE' }]

    const perTick: string[][] = []
    for (let tick = 1; tick <= 8; tick++) {
      const got = await fetchRhcPoolPrices(feeds, read, b)
      perTick.push(got.map((g) => g.feedId))
    }

    // The healthy pool is read and recorded on every tick.
    expect(calls['0xalive']).toBe(8)
    expect(perTick.every((t) => t.includes('0xalive'))).toBe(true)
    // The dead one: tried on tick 1, skipped 2 ticks, tried on tick 4, skipped 4, tried on 9 - not before.
    expect(calls['0xdead']).toBe(2)
    // A failure or a skip never yields a row: nothing was recorded for it, at all.
    expect(perTick.every((t) => !t.includes('0xdead'))).toBe(true)
  })

  it('records the pool again the tick after it recovers, once its wait is over', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const b = new FeedBackoff()
    let alive = false
    const read = async () => {
      if (!alive) throw new Error('pool has no liquidity')
      return 9n
    }
    const feeds = [{ feedId: '0xpool', symbol: 'POOL' }]

    await fetchRhcPoolPrices(feeds, read, b) // fails, waits 2
    alive = true
    expect(await fetchRhcPoolPrices(feeds, read, b)).toEqual([]) // skipped
    expect(await fetchRhcPoolPrices(feeds, read, b)).toEqual([]) // skipped
    expect(await fetchRhcPoolPrices(feeds, read, b)).toEqual([{ feedId: '0xpool', symbol: 'POOL', price: 9n }])
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0][0])).toContain('reads again')
    // And it is back on the normal cadence.
    expect(await fetchRhcPoolPrices(feeds, read, b)).toHaveLength(1)
  })
})

describe('currentFeedsQuery', () => {
  const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')
  const strip = (sql: string) =>
    sql.replace(/CREATE EXTENSION IF NOT EXISTS timescaledb;/g, '').replace(/SELECT create_hypertable\([^;]*\);/g, '')

  // Built once for the file: the migrations are the slow part.
  let shared: Promise<PGlite> | null = null
  const migrated = () => (shared ??= (async () => {
    const db = new PGlite()
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
      await db.exec(strip(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')))
    }
    return db
  })())
  beforeAll(async () => { await migrated() }, 180_000)

  async function seeded() {
    const db = await migrated()
    await db.exec('TRUNCATE TABLE markets CASCADE')
    const CURRENT = '0x' + 'c'.repeat(40)
    const OLD = '0x' + 'd'.repeat(40)
    const add = (addr: string, feed: string, symbol: string, factory: string | null, openedAt: string) =>
      db.query(
        `INSERT INTO markets(market_address, feed_id, feed_symbol, duration_secs, open_time, close_time, factory_address)
         VALUES ($1, $2, $3, 300, $4::timestamptz, NULL, $5)`,
        [addr, feed, symbol, openedAt, factory],
      )
    await add('0x01', '0xfeedA', 'PEPE', CURRENT, '2026-09-28T10:00:00Z')
    await add('0x02', '0xfeedA', 'PEPE', CURRENT, '2026-09-28T11:00:00Z') // same pool, second market
    await add('0x03', '0xfeedB', 'OLDCOIN', OLD, '2026-09-05T10:00:00Z')  // dead deployment's pool
    await add('0x04', '0xfeedC', 'NOSTAMP', null, '2026-09-01T10:00:00Z') // written before the column existed
    return { db, CURRENT }
  }

  it('on rhc, lists each current pool once and leaves out every other factory (and unstamped rows)', async () => {
    const { db, CURRENT } = await seeded()
    const rows = (await db.query<any>(currentFeedsQuery(CURRENT))).rows
    expect(rows.map((r) => r.feed_id)).toEqual(['0xfeedA'])
  })

  it('without a factory (base, or unset) lists every pool, as before', async () => {
    const { db } = await seeded()
    const rows = (await db.query<any>(currentFeedsQuery(null))).rows
    expect(rows.map((r) => r.feed_id).sort()).toEqual(['0xfeedA', '0xfeedB', '0xfeedC'])
  })
})
