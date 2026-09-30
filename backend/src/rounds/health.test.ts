import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { keeperHealthRoutes } from '../routes/keeperHealth.js'
import { evaluateRoundsHealth, roundsHealthRoutes } from './health.js'
import { ROUNDS_STATE_KEY, type DeadlineEntry, type RoundsSnapshot } from './store.js'

const NOW = 1_787_900_000_000
/** Chain time of the snapshot's tick, which happened 20 s before NOW. */
const CHAIN = 1_790_000_000

function keeperSnapshot(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    resolverEthWei: '20000000000000000',
    resolverEthAlert: 'ok',
    keeperEthWei: '50000000000000000',
    keeperEthAlert: 'ok',
    keeperAddress: '0xbFa008e5A8d46d2014b83551ce6209108416eea4',
    feedStatus: {},
    lastTick: NOW - 30_000,
    ...over,
  })
}

function rounds(over: Partial<RoundsSnapshot> = {}): string {
  const s: RoundsSnapshot = {
    version: 1,
    lastTick: NOW - 20_000,
    chainTime: CHAIN,
    tickMs: 40,
    intervalMs: 5_000,
    contract: '0x00000000000000000000000000000000000000c0',
    headBlock: '54000000',
    cursorBlock: '54000000',
    caughtUp: true,
    open: 3,
    collecting: 1,
    waiting: 1,
    awaitingFixStrike: 1,
    awaitingSettle: 0,
    awaitingGraceSettle: 0,
    overBudget: 0,
    paused: 0,
    deadlines: [],
    atRisk: 0,
    deadlineMissed: 0,
    settled24h: 0,
    refunds24h: {},
    pools: { listed: 2, belowGate: [], gateDepthWei: '50000000000000000000', delisted24h: 0, lastCheckChainTime: CHAIN - 100, delistSpentTodayWei: '0' },
    oldestSettleOverdue: null,
    spent24hWei: '123456789000',
    keeperWei: '987654321000000000',
    feesAccruedWei: '5000000000000000',
    txs: 1,
    abiMismatch: false,
    lastError: null,
    ...over,
  }
  return JSON.stringify(s)
}

/** An owed call whose deadline is `left` seconds after the snapshot's chain time. */
const owed = (left: number, over: Partial<DeadlineEntry> = {}): DeadlineEntry =>
  ({ roundId: '777777', action: 'fixStrike', dueAt: CHAIN - 60, deadlineAt: CHAIN + left, state: 'act', ...over })

const store = (entries: Record<string, string | null>) => async (key: string) => entries[key] ?? null
const at = (s: string, now = NOW) => evaluateRoundsHealth(store({ [ROUNDS_STATE_KEY]: s }), now)

describe('evaluateRoundsHealth', () => {
  it('has nothing to say when the rounds keeper is off', async () => {
    expect(await evaluateRoundsHealth(store({}), NOW)).toEqual({ state: 'absent' })
  })

  it('never throws: a failing reader is "nothing to say", a corrupt snapshot a warning', async () => {
    const boom = async () => { throw new Error('redis down') }
    expect(await evaluateRoundsHealth(boom, NOW)).toEqual({ state: 'absent' })
    expect(await at('{not json')).toEqual({ state: 'ok', warn: ['rounds-snapshot-corrupt'] })
    expect(await at('42')).toEqual({ state: 'ok', warn: ['rounds-snapshot-corrupt'] })
  })

  it('is ok on a fresh, quiet snapshot', async () => {
    expect(await at(rounds())).toMatchObject({ state: 'ok', warn: [] })
  })

  /**
   * The deadlines are judged now, not at the tick: the snapshot is 20 s old
   * here, so a call that had 60 s left then has 40 s left now - at risk.
   */
  it('warns when a due call has less than 45 s left, judged at the time of the request', async () => {
    expect(await at(rounds({ deadlines: [owed(70)] }))).toMatchObject({ state: 'ok', warn: [] }) // 50 s left now
    const v = await at(rounds({ deadlines: [owed(60)] })) // 40 s left now
    expect(v).toMatchObject({ state: 'ok', warn: ['rounds-deadline-at-risk'], atRisk: [{ roundId: '777777', action: 'fixStrike', secsLeft: 40 }] })
    // Not due yet: whatever the deadline, nothing to warn about.
    expect(await at(rounds({ deadlines: [owed(30, { dueAt: CHAIN + 25 })] }))).toMatchObject({ state: 'ok', warn: [] })
  })

  it('goes down once a call is past its hard deadline and not made', async () => {
    const v = await at(rounds({ deadlines: [owed(10), owed(15, { roundId: '8', action: 'settle' })] }))
    expect(v).toMatchObject({ state: 'down', code: 'rounds-deadline-missed' })
    expect((v as { reason: string }).reason).toMatch(/2 call\(s\) past the hard deadline, worst fixStrike 10s late/)
  })

  it('goes down when the rounds loop stops publishing, refused to start, or the ABI does not match', async () => {
    expect(await at(rounds({ lastTick: NOW - 6 * 60_000 }))).toMatchObject({ state: 'down', code: 'rounds-keeper-stale' })
    expect(await at(JSON.stringify({ version: 1, lastTick: NOW - 1000, configError: 'ROUNDS_INTERVAL_MS="30000" is outside 1000-10000 ms' })))
      .toMatchObject({ state: 'down', code: 'rounds-config-invalid', reason: expect.stringMatching(/ROUNDS_INTERVAL_MS/) })
    expect(await at(rounds({ abiMismatch: true }))).toMatchObject({ state: 'down', code: 'rounds-abi-mismatch' })
    expect(await at(rounds({ oldestSettleOverdue: { roundId: '1', secs: 3600 } }))).toMatchObject({ state: 'down', code: 'rounds-settle-stalled' })
  })

  it('warns early: settle overdue 15 min, a round held back by its budget, discovery behind', async () => {
    const v = await at(rounds({ oldestSettleOverdue: { roundId: '1', secs: 900 }, overBudget: 1, caughtUp: false }))
    expect(v).toMatchObject({ state: 'ok', warn: ['rounds-settle-overdue', 'rounds-over-budget', 'rounds-behind-chain'] })
  })

  it('warns about a pool below the gate or one delisted today, and about thin-window refunds, by name', async () => {
    const pools = (over: Partial<RoundsSnapshot['pools']>) => ({ listed: 2, belowGate: [], gateDepthWei: null, delisted24h: 0, lastCheckChainTime: null, delistSpentTodayWei: '0', ...over })
    expect(await at(rounds({ pools: pools({ belowGate: [{ pool: '0xabc', depthWei: '1' }] }) }))).toMatchObject({ state: 'ok', warn: ['rounds-pool-thin'] })
    expect(await at(rounds({ pools: pools({ delisted24h: 1 }) }))).toMatchObject({ state: 'ok', warn: ['rounds-pool-thin'] })
    expect(await at(rounds({ settled24h: 5, refunds24h: { 'thin-window': 2, 'history-gone': 1 } }))).toMatchObject({ state: 'ok', warn: ['rounds-refunds-thin'] })
    // Other refund reasons are counted and shown in /api/rounds/health, but are not this warning.
    expect(await at(rounds({ settled24h: 5, refunds24h: { grace: 1, spread: 1 } }))).toMatchObject({ state: 'ok', warn: [] })
  })

  it('reads a snapshot from an older keeper (fields missing) without inventing problems', async () => {
    expect(await at(JSON.stringify({ lastTick: NOW - 1000 }))).toMatchObject({ state: 'ok', warn: [] })
    expect(await at(rounds({ deadlines: [{ junk: true } as unknown as DeadlineEntry] }))).toMatchObject({ state: 'ok', warn: [] })
  })
})

async function build(entries: Record<string, string | null>): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(keeperHealthRoutes, { get: store(entries), now: () => NOW })
  await app.register(roundsHealthRoutes, { get: store(entries), now: () => NOW })
  await app.ready()
  return app
}

/**
 * /health/deep is what the external monitor watches. With the rounds keeper
 * off it must answer exactly what it answered before rounds existed; with it
 * on, a rounds outage turns it red, and it still says nothing but a code.
 */
describe('GET /health/deep with rounds', () => {
  it('answers byte for byte as before when there is no rounds snapshot', async () => {
    const app = await build({ 'watchdog:state': keeperSnapshot() })
    const res = await app.inject({ url: '/health/deep' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('{"status":"ok"}')

    const down = await build({ 'watchdog:state': keeperSnapshot({ keeperEthAlert: 'critical' }) })
    const r2 = await down.inject({ url: '/health/deep' })
    expect(r2.statusCode).toBe(503)
    expect(r2.body).toBe('{"status":"down","reason":"keeper-out-of-gas"}')

    const warn = await build({ 'watchdog:state': keeperSnapshot({ keeperEthAlert: 'warn' }) })
    expect((await warn.inject({ url: '/health/deep' })).body).toBe('{"status":"ok","warn":["keeper-eth-low"]}')
    await Promise.all([app.close(), down.close(), warn.close()])
  })

  it('goes red on a missed deadline while the rest of the keeper is fine', async () => {
    const app = await build({ 'watchdog:state': keeperSnapshot(), [ROUNDS_STATE_KEY]: rounds({ deadlines: [owed(5)] }) })
    const res = await app.inject({ url: '/health/deep' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'down', reason: 'rounds-deadline-missed' })
    await app.close()
  })

  it('warns while a deadline is at risk', async () => {
    const app = await build({ 'watchdog:state': keeperSnapshot(), [ROUNDS_STATE_KEY]: rounds({ deadlines: [owed(50)] }) })
    const res = await app.inject({ url: '/health/deep' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', warn: ['rounds-deadline-at-risk'] })
    await app.close()
  })

  it('goes red when switched on but refused to start', async () => {
    const app = await build({
      'watchdog:state': keeperSnapshot(),
      [ROUNDS_STATE_KEY]: JSON.stringify({ version: 1, lastTick: NOW - 1000, configError: 'ROUNDS_ADDRESS is not set' }),
    })
    expect((await app.inject({ url: '/health/deep' })).json()).toEqual({ status: 'down', reason: 'rounds-config-invalid' })
    await app.close()
  })

  it('keeps the keeper\'s own code first when both are down', async () => {
    const app = await build({
      'watchdog:state': keeperSnapshot({ keeperEthAlert: 'critical' }),
      [ROUNDS_STATE_KEY]: rounds({ abiMismatch: true }),
    })
    expect((await app.inject({ url: '/health/deep' })).json()).toEqual({ status: 'down', reason: 'keeper-out-of-gas' })
    await app.close()
  })

  it('adds rounds warnings to the keeper\'s, and leaks no number, address or round', async () => {
    const app = await build({
      'watchdog:state': keeperSnapshot({ keeperEthAlert: 'warn' }),
      [ROUNDS_STATE_KEY]: rounds({ overBudget: 2, oldestSettleOverdue: { roundId: '777777', secs: 1000 }, deadlines: [owed(55)] }),
    })
    const res = await app.inject({ url: '/health/deep' })
    expect(res.json()).toEqual({ status: 'ok', warn: ['keeper-eth-low', 'rounds-deadline-at-risk', 'rounds-settle-overdue', 'rounds-over-budget'] })
    for (const secret of ['777777', '123456789000', '987654321000000000', '0x00000000000000000000000000000000000000c0', 'snapshot']) {
      expect(res.body).not.toContain(secret)
    }
    await app.close()
  })

  it('stays green with a rounds snapshot that cannot be read', async () => {
    const app = await build({ 'watchdog:state': keeperSnapshot(), [ROUNDS_STATE_KEY]: 'garbage' })
    const res = await app.inject({ url: '/health/deep' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', warn: ['rounds-snapshot-corrupt'] })
    await app.close()
  })
})

describe('GET /api/rounds/health', () => {
  it('says off when the rounds keeper is not running', async () => {
    const app = await build({})
    const res = await app.inject({ url: '/api/rounds/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'off' })
    await app.close()
  })

  it('carries the numbers: waiting rounds, deadlines at risk, spend over 24 h, keeper balance', async () => {
    const app = await build({ [ROUNDS_STATE_KEY]: rounds({ awaitingSettle: 2, deadlines: [owed(50)] }) })
    const res = await app.inject({ url: '/api/rounds/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      status: 'ok',
      warn: ['rounds-deadline-at-risk'],
      atRisk: [{ roundId: '777777', action: 'fixStrike', secsLeft: 30 }],
      snapshot: {
        awaitingFixStrike: 1, awaitingSettle: 2, spent24hWei: '123456789000', keeperWei: '987654321000000000',
        refunds24h: {}, pools: { listed: 2, gateDepthWei: '50000000000000000000' },
      },
    })
    await app.close()
  })

  it('answers 503 with the missed calls when a deadline is gone', async () => {
    const app = await build({ [ROUNDS_STATE_KEY]: rounds({ deadlines: [owed(-100, { action: 'settle' })] }) })
    const res = await app.inject({ url: '/api/rounds/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ status: 'down', missed: [{ roundId: '777777', action: 'settle', secsLeft: -120 }] })
    await app.close()
  })
})
