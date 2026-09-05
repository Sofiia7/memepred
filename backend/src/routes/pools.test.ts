import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

/**
 * The pool feed's contract with whatever renders it.
 *
 * Two behaviours matter enough to pin. On Base the answer is an empty list
 * rather than an error, because a client showing this feed should say "no pools
 * here" on a chain that has none instead of a failure. And `reason` is passed
 * through verbatim: it is the same string poolWatcher logged when it decided,
 * so "why is there no market on my token" has one answer wherever it is asked,
 * and a new rejection reason does not have to be taught to three layers.
 */
const rows: Record<string, unknown>[] = []
let profileName = 'rhc'

vi.mock('../db/pg.js', () => ({
  pg: { query: vi.fn(async () => ({ rows, rowCount: rows.length })) },
}))
vi.mock('../chainProfile.js', () => ({
  get CHAIN_PROFILE() {
    return { name: profileName, chain: { id: profileName === 'rhc' ? 46630 : 84532 } }
  },
}))

const { poolsRoutes } = await import('./pools.js')

async function build() {
  const app = Fastify()
  await app.register(poolsRoutes, { prefix: '/api/pools' })
  await app.ready()
  return app
}

const row = (over: Record<string, unknown> = {}) => ({
  pool_address: '0xc9168555e619e4e00743d5fb14cbeaa39753a450',
  token_address: '0x89eac846356102bead3d71170961b26bb5eed6b1',
  token_symbol: 'PEPE',
  fee_tier: 10000,
  status: 'ONBOARDED',
  reason: 'every allowed duration has a market',
  weth_depth: '50.000000000000000000',
  cardinality: 300,
  first_seen_at: new Date(Date.now() - 3600_000),
  last_checked_at: new Date(Date.now() - 60_000),
  durations: [60, 300, 900],
  ...over,
})

beforeEach(() => {
  rows.length = 0
  profileName = 'rhc'
})

describe('GET /api/pools', () => {
  it('serves a pool with its decision and its reason', async () => {
    rows.push(row())
    const app = await build()
    const res = await app.inject({ url: '/api/pools' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.chainId).toBe(46630)
    expect(body.poolBacked).toBe(true)
    expect(body.pools).toHaveLength(1)

    const p = body.pools[0]
    expect(p.pool).toBe('0xc9168555e619e4e00743d5fb14cbeaa39753a450')
    expect(p.symbol).toBe('PEPE')
    expect(p.status).toBe('ONBOARDED')
    expect(p.reason).toBe('every allowed duration has a market')
    expect(p.wethDepth).toBe(50)
    expect(p.cardinality).toBe(300)
    expect(p.marketDurations).toEqual([60, 300, 900])
    expect(p.ageSec).toBeGreaterThanOrEqual(3599)
    await app.close()
  })

  /**
   * A pool the keeper is still waiting on is the common case - 292 WETH pools a
   * day and most never qualify - so the feed has to render one that has no
   * depth reading and no markets yet without inventing zeros.
   */
  it('keeps nulls as nulls for a pool nothing has measured yet', async () => {
    rows.push(row({ weth_depth: null, cardinality: null, last_checked_at: null, durations: [], status: 'PENDING', reason: 'seen' }))
    const app = await build()
    const p = (await app.inject({ url: '/api/pools' })).json().pools[0]

    expect(p.wethDepth).toBeNull()
    expect(p.cardinality).toBeNull()
    expect(p.lastCheckedSec).toBeNull()
    expect(p.marketDurations).toEqual([])
    await app.close()
  })

  it('answers with an empty list on a chain that has no pools', async () => {
    profileName = 'base'
    rows.push(row())
    const app = await build()
    const body = (await app.inject({ url: '/api/pools' })).json()

    expect(body.poolBacked).toBe(false)
    expect(body.pools).toEqual([])
    await app.close()
  })

  it('rejects a status it does not know rather than ignoring it', async () => {
    const app = await build()
    const res = await app.inject({ url: '/api/pools?status=WHATEVER' })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    await app.close()
  })

  it('caps the page size', async () => {
    const app = await build()
    const res = await app.inject({ url: '/api/pools?limit=5000' })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    await app.close()
  })
})
