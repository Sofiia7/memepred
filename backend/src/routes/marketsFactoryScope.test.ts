import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The markets API against a real (WASM) Postgres with the real migrations.
 *
 * Robinhood Chain is redeployed as the contracts change, and every deployment
 * leaves its markets in the table. Only the current factory's are to be shown;
 * a row from an earlier factory - or one written before the column existed -
 * is a 404 and absent from every list. Base never filters.
 */

const CURRENT = '0x' + 'c'.repeat(40)
const OLD     = '0x' + 'd'.repeat(40)

const state = vi.hoisted(() => ({ db: null as any, profile: 'rhc' as 'rhc' | 'base' }))

vi.mock('../db/pg.js', () => ({
  pg: { query: (sql: string, params?: unknown[]) => state.db.query(sql, params) },
}))
vi.mock('../db/redis.js', () => ({
  redis: { get: vi.fn(async () => null), setEx: vi.fn(async () => {}) },
}))
vi.mock('../chainProfile.js', () => ({
  get CHAIN_PROFILE() {
    return { name: state.profile, chain: { id: state.profile === 'rhc' ? 46630 : 84532 } }
  },
}))
vi.mock('../config.js', () => ({
  CONTRACTS: { MARKET_FACTORY: '0x' + 'C'.repeat(40) },
}))

const { marketsRoutes } = await import('./markets.js')
const { poolsRoutes } = await import('./pools.js')

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')
const strip = (sql: string) =>
  sql.replace(/CREATE EXTENSION IF NOT EXISTS timescaledb;/g, '').replace(/SELECT create_hypertable\([^;]*\);/g, '')

const FEED_1 = '0x' + '0'.repeat(24) + '1'.repeat(40) // pool 1
const FEED_2 = '0x' + '0'.repeat(24) + '2'.repeat(40)
const FEED_3 = '0x' + '0'.repeat(24) + '3'.repeat(40) // a DIFFERENT pool that carries the same ticker as pool 1

const M_CURRENT = '0x' + 'a'.repeat(40)
const M_OLD     = '0x' + 'b'.repeat(40)
const M_NOSTAMP = '0x' + 'e'.repeat(40)
const M_OTHER   = '0x' + 'f'.repeat(40)

async function build() {
  const app = Fastify()
  await app.register(marketsRoutes, { prefix: '/api/markets' })
  await app.register(poolsRoutes, { prefix: '/api/pools' })
  await app.ready()
  return app
}

beforeAll(async () => {
  const db = new PGlite()
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    await db.exec(strip(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')))
  }
  const market = (addr: string, feed: string, symbol: string, factory: string | null, duration = 300, open = 0) =>
    db.query(
      `INSERT INTO markets(market_address, feed_id, feed_symbol, duration_secs, open_time, close_time, chain_id, factory_address)
       VALUES ($1, $2, $3, $4, NOW() - make_interval(secs => $5), NULL, 46630, $6)`,
      [addr, feed, symbol, duration, open, factory],
    )
  // Newest first by open_time: the two dead ones were opened long ago.
  await market(M_CURRENT, FEED_1, 'PEPE', CURRENT, 300, 100)
  await market(M_OTHER,   FEED_3, 'PEPE', CURRENT, 900, 200)
  await market(M_OLD,     FEED_1, 'PEPE', OLD,     60,  3_000_000)
  await market(M_NOSTAMP, FEED_2, 'DEAD', null,    300, 4_000_000)

  // Orders, for the 24h volume.
  const order = (mkt: string, id: number, filled: number) =>
    db.query(
      `INSERT INTO orders(market_address, order_id, trader_address, direction, amount_usdc, filled_amount, status, placed_at, feed_symbol)
       VALUES ($1, $2, '0xtrader', 'UP', $3, $3, 'MATCHED', NOW(), 'X')`,
      [mkt, id, filled],
    )
  await order(M_CURRENT, 1, 1)
  await order(M_OLD, 1, 5)

  // Prices: two pools that share a ticker, and one dead pool.
  const price = (feed: string, symbol: string, p: number, hoursAgo: number) =>
    db.query(
      `INSERT INTO price_history(feed_id, symbol, price, recorded_at) VALUES ($1, $2, $3, NOW() - make_interval(hours => $4))`,
      [feed, symbol, p, hoursAgo],
    )
  await price(FEED_1, 'PEPE', 1.0, 30)
  await price(FEED_1, 'PEPE', 1.1, 0)
  await price(FEED_3, 'PEPE', 2.0, 30)
  await price(FEED_3, 'PEPE', 1.0, 0)

  // The pool feed's candidate rows for pool 1 and pool 3.
  const candidate = (pool: string, symbol: string) =>
    db.query(
      `INSERT INTO pool_candidates(pool_address, chain_id, token_address, token_symbol, fee_tier, created_block, status)
       VALUES ($1, 46630, '0xtoken', $2, 3000, 1, 'ONBOARDED')`,
      [pool, symbol],
    )
  await candidate('0x' + '1'.repeat(40), 'PEPE')

  state.db = db
}, 180_000)

beforeEach(() => {
  state.profile = 'rhc'
})

describe('GET /api/markets on rhc', () => {
  it('lists only the current factory, newest first, and leaves out every other one', async () => {
    const app = await build()
    const res = await app.inject({ url: '/api/markets' })

    expect(res.statusCode).toBe(200)
    expect(res.json().map((m: any) => m.address)).toEqual([M_CURRENT, M_OTHER])
    await app.close()
  })

  it('does not list a market from an earlier factory, nor one written before the column existed', async () => {
    const app = await build()
    const addresses = (await app.inject({ url: '/api/markets' })).json().map((m: any) => m.address)

    expect(addresses).not.toContain(M_OLD)
    expect(addresses).not.toContain(M_NOSTAMP)
    await app.close()
  })

  it('composes with the existing filters', async () => {
    const app = await build()
    const byFeed = (await app.inject({ url: `/api/markets?feedId=${FEED_1}` })).json()
    // Pool 1 has a current market and an old one; only the current one shows.
    expect(byFeed.map((m: any) => m.address)).toEqual([M_CURRENT])

    const byOldFeed = (await app.inject({ url: `/api/markets?feedId=${FEED_2}` })).json()
    expect(byOldFeed).toEqual([])
    await app.close()
  })

  it('answers 404 for a market of an earlier factory, exactly as if it did not exist', async () => {
    const app = await build()
    expect((await app.inject({ url: `/api/markets/${M_OLD}` })).statusCode).toBe(404)
    expect((await app.inject({ url: `/api/markets/${M_NOSTAMP}` })).statusCode).toBe(404)
    await app.close()
  })

  it('still serves a current market by address', async () => {
    const app = await build()
    const res = await app.inject({ url: `/api/markets/${M_CURRENT}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ address: M_CURRENT, duration: 300 })
    await app.close()
  })
})

describe('GET /api/markets on base', () => {
  it('does not filter: every row is served, as it always was', async () => {
    state.profile = 'base'
    const app = await build()

    const list = (await app.inject({ url: '/api/markets' })).json().map((m: any) => m.address)
    expect(list.sort()).toEqual([M_CURRENT, M_OLD, M_NOSTAMP, M_OTHER].sort())
    expect((await app.inject({ url: `/api/markets/${M_OLD}` })).statusCode).toBe(200)
    await app.close()
  })
})

describe('GET /api/markets/stats', () => {
  it('on rhc keeps two pools with the same ticker apart, each with its own price and change', async () => {
    const app = await build()
    const body = (await app.inject({ url: '/api/markets/stats' })).json()

    const one = body.symbols.find((s: any) => s.feedId === FEED_1)
    const three = body.symbols.find((s: any) => s.feedId === FEED_3)
    expect(one).toMatchObject({ symbol: 'PEPE', price: 1.1 })
    expect(three).toMatchObject({ symbol: 'PEPE', price: 1 })
    expect(one.chg24h).toBeCloseTo(10, 5)     // 1.0 -> 1.1
    expect(three.chg24h).toBeCloseTo(-50, 5)  // 2.0 -> 1.0
    expect(body.symbols).toHaveLength(2)
    await app.close()
  })

  it('counts only the current factory in the 24h volume', async () => {
    const app = await build()
    const body = (await app.inject({ url: '/api/markets/stats' })).json()
    expect(body.volume24h).toBe(1) // the old factory's 5 is not part of what the product is doing
    await app.close()
  })

  it('on base still folds a symbol into one row (it IS the feed there) and counts all volume', async () => {
    state.profile = 'base'
    const app = await build()
    const body = (await app.inject({ url: '/api/markets/stats' })).json()

    // Both PEPE feeds collapse into the newest PEPE row, as before this change.
    expect(body.symbols).toHaveLength(1)
    expect(body.symbols[0].symbol).toBe('PEPE')
    // ...and every row now also says which feed it is.
    expect(typeof body.symbols[0].feedId).toBe('string')
    expect(body.volume24h).toBe(6)
    await app.close()
  })
})

describe('GET /api/pools market durations', () => {
  it('lists only the durations of markets the current factory created', async () => {
    const app = await build()
    const body = (await app.inject({ url: '/api/pools' })).json()

    const pool = body.pools.find((p: any) => p.pool === '0x' + '1'.repeat(40))
    // Pool 1 has a 300s market on the current factory and a 60s one on the old
    // factory. The 60 is a market nobody can use.
    expect(pool.marketDurations).toEqual([300])
    await app.close()
  })
})
