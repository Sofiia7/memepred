import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { oracleRoutes } from './oracle.js'

let app: FastifyInstance
let fetchPayload: Mock<(symbol: string) => Promise<string>>
let fetchPrice: Mock<(symbol: string) => Promise<number>>

beforeEach(async () => {
  fetchPayload = vi.fn(async (symbol: string) => `0xpayload_${symbol}`)
  fetchPrice   = vi.fn(async (_symbol: string) => 0.00000392)

  app = Fastify()
  await app.register(oracleRoutes, {
    allowedFeeds: new Set(['PEPE', 'DOGE']),
    fetchPayload,
    fetchPrice,
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  vi.useRealTimers()
})

describe('GET /payload', () => {
  it('returns a signed payload for a feed we run', async () => {
    const res = await app.inject({ url: '/payload?feed=PEPE' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ feed: 'PEPE', payload: '0xpayload_PEPE' })
  })

  /**
   * Otherwise this is a free proxy to every feed RedStone publishes, running on
   * our gateway budget. RedStone charges nothing today, but an open endpoint is
   * a liability regardless of who is paying.
   */
  it('refuses a feed we do not run markets on', async () => {
    const res = await app.inject({ url: '/payload?feed=BTC' })

    expect(res.statusCode).toBe(400)
    expect(fetchPayload).not.toHaveBeenCalled()
  })

  it('requires a feed at all', async () => {
    expect((await app.inject({ url: '/payload' })).statusCode).toBe(400)
  })

  /**
   * OrderbookMarket rejects a price older than ENTRY_MAX_PRICE_AGE, 20 seconds,
   * and the clock starts when the payload is signed - not when it is served.
   * A user still has to read the confirmation and sign, so the cache has to
   * leave most of that window unspent.
   */
  it('caches a payload only briefly, so it survives the user signing', async () => {
    vi.useFakeTimers()

    await app.inject({ url: '/payload?feed=PEPE' })
    vi.advanceTimersByTime(2_000)
    await app.inject({ url: '/payload?feed=PEPE' })

    expect(fetchPayload).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2_000)
    await app.inject({ url: '/payload?feed=PEPE' })

    expect(fetchPayload).toHaveBeenCalledTimes(2)
  })

  it('does not serve one feed from another feed cache entry', async () => {
    await app.inject({ url: '/payload?feed=PEPE' })
    await app.inject({ url: '/payload?feed=DOGE' })

    expect(fetchPayload).toHaveBeenCalledTimes(2)
  })

  it('reports an upstream failure as 502, not as the browser being at fault', async () => {
    fetchPayload.mockRejectedValueOnce(new Error('redstone gateway 503'))

    expect((await app.inject({ url: '/payload?feed=PEPE' })).statusCode).toBe(502)
  })

  it('does not cache a failure', async () => {
    fetchPayload.mockRejectedValueOnce(new Error('boom'))

    expect((await app.inject({ url: '/payload?feed=PEPE' })).statusCode).toBe(502)
    expect((await app.inject({ url: '/payload?feed=PEPE' })).statusCode).toBe(200)
  })
})

describe('GET /price', () => {
  it('returns the current price for display', async () => {
    const res = await app.inject({ url: '/price?feed=PEPE' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ feed: 'PEPE', price: 0.00000392 })
  })

  /**
   * The display poll is the whole load: every open page refetches on a timer,
   * so without a cache the upstream request rate scales with visitor count.
   * Nothing is gained by being fresher than the only consumer.
   */
  it('caches a displayed price for as long as the frontend polls', async () => {
    vi.useFakeTimers()

    await app.inject({ url: '/price?feed=PEPE' })
    vi.advanceTimersByTime(9_000)
    await app.inject({ url: '/price?feed=PEPE' })

    expect(fetchPrice).toHaveBeenCalledTimes(1)
  })

  it('refreshes a displayed price eventually', async () => {
    vi.useFakeTimers()

    await app.inject({ url: '/price?feed=PEPE' })
    vi.advanceTimersByTime(11_000)
    await app.inject({ url: '/price?feed=PEPE' })

    expect(fetchPrice).toHaveBeenCalledTimes(2)
  })

  it('applies the same feed whitelist', async () => {
    expect((await app.inject({ url: '/price?feed=BTC' })).statusCode).toBe(400)
    expect(fetchPrice).not.toHaveBeenCalled()
  })
})
