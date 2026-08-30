import { describe, it, expect, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { keeperHealthRoutes } from './keeperHealth.js'

const NOW = 1_787_900_000_000

function snapshot(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    resolverEthWei:   '20000000000000000',
    resolverEthAlert: 'ok',
    keeperEthWei:     '50000000000000000',
    keeperEthAlert:   'ok',
    keeperAddress:    '0xbFa008e5A8d46d2014b83551ce6209108416eea4',
    feedStatus:       {},
    lastTick:         NOW - 30_000,
    ...over,
  })
}

/** Stands in for Redis; the routes read exactly two keys. */
function store(entries: Record<string, string | null>) {
  return async (key: string) => entries[key] ?? null
}

async function build(entries: Record<string, string | null>): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(keeperHealthRoutes, { get: store(entries), now: () => NOW })
  await app.ready()
  return app
}

describe('GET /api/keeper/health', () => {
  it('reports ok with the full snapshot when everything is healthy', async () => {
    const app = await build({ 'watchdog:state': snapshot() })
    const res = await app.inject({ url: '/api/keeper/health' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', snapshot: { keeperEthAlert: 'ok' } })
    await app.close()
  })

  it('reports 503 when the keeper wallet is out of gas', async () => {
    const app = await build({ 'watchdog:state': snapshot({ keeperEthAlert: 'critical' }) })
    const res = await app.inject({ url: '/api/keeper/health' })

    expect(res.statusCode).toBe(503)
    expect(res.json().reason).toMatch(/out of gas/)
    await app.close()
  })
})

/**
 * The probe an external uptime monitor watches. Two properties matter and
 * neither is cosmetic:
 *
 *  1. It must go RED on a dead keeper. `/health` returns `{status:'ok'}` for as
 *     long as the Fastify process has a pulse, which is precisely how a
 *     15-day production stall stayed green on UptimeRobot.
 *  2. It must not answer with the snapshot. This path is geo-exempt (the edge
 *     Worker lets it through from blocked regions so monitors can reach it), so
 *     whatever it returns is readable by anyone, anywhere.
 */
describe('GET /health/deep', () => {
  it('goes red when the watchdog snapshot is stale', async () => {
    const app = await build({ 'watchdog:state': snapshot({ lastTick: NOW - 10 * 60_000 }) })
    const res = await app.inject({ url: '/health/deep' })

    expect(res.statusCode).toBe(503)
    expect(res.json().status).toBe('down')
    await app.close()
  })

  it('goes red when the keeper has not started at all', async () => {
    const app = await build({ 'watchdog:state': null })
    const res = await app.inject({ url: '/health/deep' })

    expect(res.statusCode).toBe(503)
    await app.close()
  })

  it('goes red on USDC invariant drift', async () => {
    const app = await build({
      'watchdog:state':     snapshot(),
      'invariant:critical': JSON.stringify({ drift: 12.5 }),
    })
    const res = await app.inject({ url: '/health/deep' })

    expect(res.statusCode).toBe(503)
    await app.close()
  })

  it('is green when the keeper is healthy', async () => {
    const app = await build({ 'watchdog:state': snapshot() })
    const res = await app.inject({ url: '/health/deep' })

    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('ok')
    await app.close()
  })

  it('never leaks the snapshot, balances or the keeper address', async () => {
    const app = await build({ 'watchdog:state': snapshot({ keeperEthAlert: 'critical' }) })
    const body = (await app.inject({ url: '/health/deep' })).body

    expect(body).not.toContain('0xbFa008e5A8d46d2014b83551ce6209108416eea4')
    expect(body).not.toContain('50000000000000000')
    expect(body).not.toContain('snapshot')
    await app.close()
  })

  /**
   * The gap this probe was built to close, still open until now.
   *
   * Every existing red condition is about the keeper's ability to *act*: gas,
   * nonce, liveness. A keeper with a full tank and a clean nonce whose
   * settlements simply revert in simulation trips none of them - resolveKeeper
   * logs "settle would revert, skipping" and moves on. The USDC invariant does
   * not drift either, because nothing settled on-chain, so the ledger still
   * agrees with the chain. Result: matches sit unsettled indefinitely behind a
   * 200. That is the same shape as the outage this file's header describes.
   */
  it('goes red when matches are long overdue for settlement', async () => {
    const app = await build({ 'watchdog:state': snapshot({ settlementsOverdueSecs: 2 * 3600 }) })
    const res = await app.inject({ url: '/health/deep' })

    expect(res.statusCode).toBe(503)
    expect(res.json().reason).toBe('settlements-stalled')
    await app.close()
  })

  it('warns before going red, while a settlement backlog is still plausibly a delay', async () => {
    const app = await build({ 'watchdog:state': snapshot({ settlementsOverdueSecs: 20 * 60 }) })
    const res = await app.inject({ url: '/health/deep' })

    expect(res.statusCode).toBe(200)
    expect(res.json().warn).toContain('settlements-overdue')
    await app.close()
  })

  it('stays quiet about a settlement running a couple of minutes behind', async () => {
    const app = await build({ 'watchdog:state': snapshot({ settlementsOverdueSecs: 120 }) })
    const res = await app.inject({ url: '/health/deep' })

    expect(res.statusCode).toBe(200)
    expect(res.json().warn).toBeUndefined()
    await app.close()
  })

  it('does not go red on a snapshot published before this field existed', async () => {
    const app = await build({ 'watchdog:state': snapshot({ settlementsOverdueSecs: undefined }) })
    const res = await app.inject({ url: '/health/deep' })

    expect(res.statusCode).toBe(200)
    await app.close()
  })

  /**
   * An oracle-side outage stops price pushes and settlement alike, but it is
   * upstream and self-healing, and the watchdog deliberately pauses nothing
   * over it. It still has to be visible immediately rather than only once the
   * settlement backlog crosses an hour.
   */
  it('warns while no feed is answering at all', async () => {
    const app = await build({ 'watchdog:state': snapshot({ oracleOutage: true }) })
    const res = await app.inject({ url: '/health/deep' })

    expect(res.statusCode).toBe(200)
    expect(res.json().warn).toContain('oracle-outage')
    await app.close()
  })
})

/**
 * Green-but-degraded. The point is lead time: 'warn' is what the keeper wallet
 * reads at three days of runway, and three days is enough to act on. Waiting
 * for 'critical' means learning about it from settlements that stopped.
 */
describe('warnings on an otherwise green probe', () => {
  it('flags a low keeper balance without going red', async () => {
    const app = await build({ 'watchdog:state': snapshot({ keeperEthAlert: 'warn' }) })
    const res = await app.inject({ url: '/health/deep' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', warn: ['keeper-eth-low'] })
    await app.close()
  })

  it('flags a feed that is failing to publish', async () => {
    const app = await build({
      'watchdog:state': snapshot({ feedStatus: { PEPE: { failStreak: 3 } } }),
    })

    expect((await app.inject({ url: '/health/deep' })).json().warn).toEqual(['feed-degraded'])
    await app.close()
  })

  it('omits the key entirely when nothing is degraded', async () => {
    const app = await build({ 'watchdog:state': snapshot() })

    expect((await app.inject({ url: '/health/deep' })).json()).toEqual({ status: 'ok' })
    await app.close()
  })
})

/**
 * The gas guard skips routine sends when the fee is above the ceiling. That is
 * the intended behaviour, and it is also indistinguishable from a healthy
 * keeper unless it is published: prices stop refreshing, markets stop rolling,
 * and every probe stays green.
 */
describe('gas throttle', () => {
  it('warns while routine sends are being skipped', async () => {
    const app = await build({
      'watchdog:state': snapshot({ gasThrottled: true, gasThrottleReason: 'fee 2.000 gwei > ceiling 0.150 gwei' }),
    })
    const res = await app.inject({ url: '/health/deep' })

    expect(res.statusCode).toBe(200)
    expect(res.json().warn).toContain('gas-throttled')
    await app.close()
  })

  it('keeps the ceiling numbers off the public probe', async () => {
    const app = await build({
      'watchdog:state': snapshot({ gasThrottled: true, gasThrottleReason: 'fee 2.000 gwei > ceiling 0.150 gwei' }),
    })

    expect((await app.inject({ url: '/health/deep' })).body).not.toContain('gwei')
    await app.close()
  })
})

/**
 * A transaction that occupies a nonce and never mines blocks every later write
 * from the same wallet: no settlements, no price pushes, no rollovers - while
 * the process, the database and the API all stay perfectly healthy. It happened
 * on 2026-08-28 and looked, from outside, like nothing at all.
 */
describe('wedged nonce', () => {
  it('is only a warning while escalation is still working on it', async () => {
    const app = await build({ 'watchdog:state': snapshot({ stuckNonce: 3980, escalationLevel: 1 }) })
    const res = await app.inject({ url: '/health/deep' })

    expect(res.statusCode).toBe(200)
    expect(res.json().warn).toContain('nonce-escalating')
    await app.close()
  })

  it('goes red once escalation has stopped helping', async () => {
    const app = await build({ 'watchdog:state': snapshot({ stuckNonce: 3980, escalationLevel: 3 }) })
    const res = await app.inject({ url: '/health/deep' })

    expect(res.statusCode).toBe(503)
    expect(res.json().reason).toBe('nonce-wedged')
    await app.close()
  })

  it('names the nonce on the operator-facing route but not the public one', async () => {
    const app = await build({ 'watchdog:state': snapshot({ stuckNonce: 3980, escalationLevel: 5 }) })

    expect((await app.inject({ url: '/api/keeper/health' })).json().reason).toContain('3980')
    expect((await app.inject({ url: '/health/deep' })).body).not.toContain('3980')
    await app.close()
  })

  it('an old snapshot without the field is not treated as wedged', async () => {
    const app = await build({ 'watchdog:state': snapshot() })

    expect((await app.inject({ url: '/health/deep' })).statusCode).toBe(200)
    await app.close()
  })
})
