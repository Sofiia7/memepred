import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { pythRoutes } from './pyth.js'

const PEPE = '0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4'
const DOGE = '0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c'
const NOT_OURS = '0x' + 'ab'.repeat(32)

const KEY = 'pyth-api-key-value'
const UPSTREAM = 'https://hermes.example'

let app: FastifyInstance
let upstream: ReturnType<typeof vi.fn>

const body = (n = 1) => JSON.stringify({ binary: { data: [`beef${n}`] } })

beforeEach(async () => {
  upstream = vi.fn(async () => new Response(body(), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', upstream)

  app = Fastify()
  await app.register(pythRoutes, {
    apiKey:       KEY,
    hermesUrl:    UPSTREAM,
    allowedFeeds: new Set([PEPE, DOGE]),
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('GET /updates', () => {
  it('returns the upstream price update for a whitelisted feed', async () => {
    const res = await app.inject({ url: `/updates?ids=${PEPE}` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ binary: { data: ['beef1'] } })
  })

  // The key is a server-side secret. This route exists so the browser never
  // needs it; if it ever appeared in a response the whole point is lost.
  it('never puts the api key in the response', async () => {
    const res = await app.inject({ url: `/updates?ids=${PEPE}` })
    expect(res.body).not.toContain(KEY)
    expect(JSON.stringify(res.headers)).not.toContain(KEY)
  })

  it('sends our bearer token upstream so the browser does not have to', async () => {
    await app.inject({ url: `/updates?ids=${PEPE}` })

    const [, init] = upstream.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
  })

  // Without this the endpoint is an open, authenticated proxy to Pyth on our
  // quota: anyone could point a script at it and pull any feed they liked.
  it('refuses a feed we do not run markets on', async () => {
    const res = await app.inject({ url: `/updates?ids=${NOT_OURS}` })

    expect(res.statusCode).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('refuses a malformed feed id without calling upstream', async () => {
    for (const bad of ['', 'notahex', '0x123', `${PEPE}extra`]) {
      const res = await app.inject({ url: `/updates?ids=${bad}` })
      expect(res.statusCode).toBe(400)
    }
    expect(upstream).not.toHaveBeenCalled()
  })

  it('matches the whitelist regardless of hex casing', async () => {
    const res = await app.inject({ url: `/updates?ids=${PEPE.toUpperCase().replace('0X', '0x')}` })
    expect(res.statusCode).toBe(200)
  })

  it('passes the parsed flag through so one route serves prices and bet payloads', async () => {
    await app.inject({ url: `/updates?ids=${PEPE}&parsed=true` })
    expect(upstream.mock.calls[0][0]).toContain('parsed=true')

    await app.inject({ url: `/updates?ids=${DOGE}&parsed=false` })
    expect(upstream.mock.calls[1][0]).toContain('parsed=false')
  })

  it('always requests hex encoding, whatever the caller asks for', async () => {
    await app.inject({ url: `/updates?ids=${PEPE}&encoding=base64` })
    expect(upstream.mock.calls[0][0]).toContain('encoding=hex')
    expect(upstream.mock.calls[0][0]).not.toContain('base64')
  })
})

describe('quota', () => {
  // usePythPrice polls on every open page. Without a cache, N visitors is N
  // times the poll rate against a metered upstream.
  it('serves a repeated request from cache instead of hitting Pyth again', async () => {
    const first  = await app.inject({ url: `/updates?ids=${PEPE}&parsed=true` })
    const second = await app.inject({ url: `/updates?ids=${PEPE}&parsed=true` })

    expect(upstream).toHaveBeenCalledTimes(1)
    expect(second.body).toBe(first.body)
    expect(second.statusCode).toBe(200)
  })

  it('does not serve one feed from another feed cache entry', async () => {
    await app.inject({ url: `/updates?ids=${PEPE}&parsed=true` })
    await app.inject({ url: `/updates?ids=${DOGE}&parsed=true` })

    expect(upstream).toHaveBeenCalledTimes(2)
  })

  it('does not serve a bet payload from the parsed-price cache entry', async () => {
    await app.inject({ url: `/updates?ids=${PEPE}&parsed=true` })
    await app.inject({ url: `/updates?ids=${PEPE}&parsed=false` })

    expect(upstream).toHaveBeenCalledTimes(2)
  })

  // A bet is signed against this price and the contract rejects anything older
  // than MAX_PRICE_AGE (60s), so the cache has to be short enough to stay well
  // inside that.
  it('refetches once the entry is stale', async () => {
    vi.useFakeTimers()

    await app.inject({ url: `/updates?ids=${PEPE}` })
    vi.advanceTimersByTime(3_000)
    await app.inject({ url: `/updates?ids=${PEPE}` })

    expect(upstream).toHaveBeenCalledTimes(2)
  })
})

describe('upstream failures', () => {
  it('reports a credentials problem as 502, not as the browser being unauthorized', async () => {
    upstream.mockResolvedValue(new Response('unauthorized', { status: 401 }))

    const res = await app.inject({ url: `/updates?ids=${PEPE}` })

    // 401 back to the browser would render as "you are not logged in", which is
    // both wrong and unactionable. The failure is on our side of the wire.
    expect(res.statusCode).toBe(502)
  })

  it('does not cache a failure', async () => {
    upstream.mockResolvedValueOnce(new Response('nope', { status: 503 }))

    const bad = await app.inject({ url: `/updates?ids=${PEPE}` })
    expect(bad.statusCode).toBe(502)

    const good = await app.inject({ url: `/updates?ids=${PEPE}` })
    expect(good.statusCode).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(2)
  })
})
