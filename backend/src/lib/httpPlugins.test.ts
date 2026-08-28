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
  app.get('/api/markets', async () => ([]))
  await app.ready()
  return app
}

beforeEach(() => { markActivity = vi.fn(async () => {}) })

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
    const hit = () => app.inject({ url: '/api/markets', remoteAddress: '203.0.113.9' })

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
   * entirely.
   */
  it('ignores a spoofed client IP that does not carry the worker secret', async () => {
    const app = await build()
    const hit = (ip: string) => app.inject({
      url: '/api/markets',
      remoteAddress: '10.0.0.1',
      headers: { 'cf-connecting-ip': ip },
    })

    for (let i = 0; i < 3; i++) await hit('198.51.100.1')
    expect((await hit('198.51.100.99')).statusCode).toBe(429)
    await app.close()
  })
})

describe('user-presence hook', () => {
  it('counts a real product request as somebody being here', async () => {
    const app = await build()
    await app.inject({ url: '/api/markets' })

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
