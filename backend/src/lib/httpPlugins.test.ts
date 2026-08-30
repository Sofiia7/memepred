import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerHttpPlugins, DEFAULT_ORIGINS } from './httpPlugins.js'

const SECRET = 'worker-secret-for-tests'

let markActivity: Mock<() => Promise<void>>

async function build(over: Partial<Parameters<typeof registerHttpPlugins>[1]> = {}): Promise<FastifyInstance> {
  const app = Fastify()
  await registerHttpPlugins(app, {
    corsOrigins:  DEFAULT_ORIGINS,
    workerSecret: SECRET,
    rateLimitMax: 3,
    markActivity,
    ...over,
  })
  app.get('/health', async () => ({ status: 'ok' }))
  app.get('/health/deep', async () => ({ status: 'ok' }))
  app.get('/health/edge', async () => ({ status: 'ok' }))
  app.get('/api/markets', async () => ([]))
  await app.ready()
  return app
}

beforeEach(() => { markActivity = vi.fn(async () => {}) })

/**
 * The origin is reachable directly - its IP resolves and Caddy answers for the
 * hostname - so "the frontend never hits this directly in prod" was an
 * aspiration, not a control. Geo-blocking lived only at the Cloudflare edge,
 * which meant anyone who found the IP got the full API from a blocked country:
 * markets, profile, and the signed oracle payload needed to place a bet.
 *
 * The origin does not re-implement the country list. The edge already refuses
 * blocked countries before forwarding, so a request arriving with a valid
 * worker secret has passed that check by construction. What the origin has to
 * establish is only that the request came through the edge at all.
 */
describe('edge enforcement', () => {
  it('refuses a request that did not come through the edge', async () => {
    const app = await build()
    const res = await app.inject({ url: '/api/markets' })

    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('serves a request the edge vouched for', async () => {
    const app = await build()
    const res = await app.inject({
      url: '/api/markets',
      headers: { 'x-worker-secret': SECRET, 'x-country': 'RS' },
    })

    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('refuses a forged secret', async () => {
    const app = await build()
    const res = await app.inject({
      url: '/api/markets',
      headers: { 'x-worker-secret': 'not-the-secret' },
    })

    expect(res.statusCode).toBe(403)
    await app.close()
  })

  /**
   * Monitors reach these from outside the edge on purpose, and both are
   * deliberately world-readable - a fixed machine word, no balances, no
   * addresses. Requiring the edge here would blind the only external check
   * that production is alive.
   */
  it.each(['/health', '/health/deep'])('leaves %s reachable without the edge', async (url) => {
    const app = await build()

    expect((await app.inject({ url })).statusCode).toBe(200)
    await app.close()
  })

  it('does not enforce when no secret is configured, for local development', async () => {
    const app = await build({ workerSecret: undefined })
    const res = await app.inject({ url: '/api/markets' })

    expect(res.statusCode).toBe(200)
    await app.close()
  })

  /**
   * The probe that makes the secret pairing observable.
   *
   * Both existing monitor targets are edge-exempt, so if the Worker's secret
   * and the origin's ever drift apart, every product route would answer 403
   * while the watchdog stayed green - a fresh version of the outage the deep
   * probe exists to prevent. /health/edge is deliberately the other way round:
   * geo-exempt at the edge so a monitor anywhere can reach it, and NOT
   * edge-exempt here, so it can only answer when the pairing works. It carries
   * nothing but a status word.
   */
  it('gates /health/edge on the edge, unlike the other probes', async () => {
    const app = await build()

    expect((await app.inject({ url: '/health/edge' })).statusCode).toBe(403)
    expect((await app.inject({
      url: '/health/edge',
      headers: { 'x-worker-secret': SECRET },
    })).statusCode).toBe(200)
    await app.close()
  })
})

describe('CORS', () => {
  it('allows the production origin', async () => {
    const app = await build()
    const res = await app.inject({ url: '/api/markets', headers: { origin: 'https://flipthememe.com' } })

    expect(res.headers['access-control-allow-origin']).toBe('https://flipthememe.com')
    await app.close()
  })

  it('does not hand the header to a foreign origin', async () => {
    const app = await build()
    const res = await app.inject({ url: '/api/markets', headers: { origin: 'https://evil.example' } })

    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    await app.close()
  })
})

describe('rate limiting', () => {
  it('cuts a client off past the limit', async () => {
    const app = await build()
    const hit = () => app.inject({
      url: '/api/markets',
      remoteAddress: '203.0.113.9',
      headers: { 'x-worker-secret': SECRET },
    })

    for (let i = 0; i < 3; i++) expect((await hit()).statusCode).toBe(200)
    expect((await hit()).statusCode).toBe(429)
    await app.close()
  })

  /**
   * The bug this guards, found in production on 2026-08-09: behind Caddy every
   * request presents the same peer address, so the default req.ip key gave the
   * entire internet one shared 100/min budget. One person with a phone could
   * lock the API for everyone.
   */
  it('gives two real clients separate budgets when Cloudflare identifies them', async () => {
    const app = await build()
    const hit = (ip: string) => app.inject({
      url: '/api/markets',
      remoteAddress: '10.0.0.1', // the Caddy container, identical for both
      headers: { 'x-worker-secret': SECRET, 'cf-connecting-ip': ip },
    })

    for (let i = 0; i < 3; i++) await hit('198.51.100.1')
    expect((await hit('198.51.100.1')).statusCode).toBe(429)
    expect((await hit('198.51.100.2')).statusCode).toBe(200)
    await app.close()
  })

  /**
   * The origin answers on its own IP, so an unauthenticated CF-Connecting-IP
   * would let anyone mint a fresh bucket per request and skip rate limiting
   * entirely. Proof-of-edge now refuses that request before the limiter ever
   * keys it, which is the stronger version of the same guarantee; the keying
   * rule itself is covered directly in clientKey.test.ts.
   */
  it('refuses a spoofed client IP outright rather than keying on it', async () => {
    const app = await build()
    const res = await app.inject({
      url: '/api/markets',
      remoteAddress: '10.0.0.1',
      headers: { 'cf-connecting-ip': '198.51.100.99' },
    })

    expect(res.statusCode).toBe(403)
    await app.close()
  })
})

describe('user-presence hook', () => {
  it('counts a real product request as somebody being here', async () => {
    const app = await build()
    await app.inject({ url: '/api/markets', headers: { 'x-worker-secret': SECRET } })

    expect(markActivity).toHaveBeenCalledTimes(1)
    await app.close()
  })

  /**
   * The watchdog polls /health/deep every two minutes forever. If that counted
   * as a user, the keeper would never drop to its idle price cadence and the
   * monitor would quietly pay for itself in gas.
   */
  it('does not let the uptime monitor pass for a user', async () => {
    const app = await build()
    await app.inject({ url: '/health' })
    await app.inject({ url: '/health/deep' })

    expect(markActivity).not.toHaveBeenCalled()
    await app.close()
  })

  it('ignores the query string when deciding', async () => {
    const app = await build()
    await app.inject({ url: '/health/deep?from=uptimerobot' })

    expect(markActivity).not.toHaveBeenCalled()
    await app.close()
  })
})
