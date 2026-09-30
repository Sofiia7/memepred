import { describe, it, expect } from 'vitest'
import { decodeFunctionData, encodeFunctionData, type PublicClient } from 'viem'
import { createRoundsClient } from './roundsClient'
import { POOL_ROUNDS_ABI } from './roundsAbi'
import { activationFloor } from './roundMath'

/**
 * The adapter is the one place that knows the contract's shapes. These tests
 * pin what it turns PoolRounds interface v3 into, with a fake client that
 * answers by function name, so a change of ABI shows up here and nowhere else.
 */
const ADDR = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const
const POOL = '0x52908400098527886E0F7030069857D2E4169EE7' as const
const OTHER = '0x1111111111111111111111111111111111111111' as const
const PLAYER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const

function fakeClient(over: Record<string, (args: any) => unknown> = {}, logs: (req: any) => unknown[] = () => []) {
  const answers: Record<string, (args: any) => unknown> = {
    weth: () => '0x00000000000000000000000000000000000000ee',
    minStake: () => 5n,
    maxStake: () => 40n,
    minBank: () => 20n,
    costAllowance: () => 69_692_000_000_000n,
    paused: () => false,
    NORMAL_FEE_BPS: () => 200n,
    VOID_FEE_BPS: () => 100n,
    strikePause: () => 300n,
    strikeWindow: () => 300n,
    SETTLE_GRACE: () => 86_400n,
    maxSideRatio: () => 1n,
    depthPerBank: () => 2500n,
    gateDepth: () => 50n * 10n ** 18n,
    wethDepth: () => 100n * 10n ** 18n,
    maxBankOf: () => 40_000_000_000_000_000n,
    pools: ([p]: any) => [p.toLowerCase() === POOL.toLowerCase(), false],
    durationEnabled: ([d]: any) => d === 300n,
    roundTimes: () => ({ openAt: 100n, closeAt: 400n, strikeStart: 700n, strikeEnd: 1000n, settleAt: 1300n }),
    roundView: () => ({
      pool: POOL, duration: 300n, index: 7n, times: {}, committed: 50n, rawUp: 30n, rawDown: 20n, acceptedUp: 20n, acceptedDown: 20n,
      bank: 40n, minBank: 20n, costAllowance: 398_000_000_000_000n, bookClosed: true, activated: true, strikeFixed: false, outcome: 1,
      entryTick: 0, exitTick: 0,
    }),
    ticketOf: () => [20n, 2, 1],
    previewClaim: () => [39n, 0n],
    ...over,
  }
  return {
    readContract: async ({ functionName, args }: any) => {
      const f = answers[functionName]
      if (!f) throw new Error(`no answer for ${functionName}`)
      return f(args ?? [])
    },
    getLogs: async (req: any) => logs(req),
  } as unknown as PublicClient
}

describe('RoundsClient adapter for PoolRounds interface v3', () => {
  it('reads the contract-wide values into the screen\'s types', async () => {
    const c = await createRoundsClient(fakeClient(), ADDR, 0n).constants()
    expect(c).toMatchObject({
      minStake: 5n, maxStake: 40n, minBank: 20n, costAllowance: 69_692_000_000_000n, normalFeeBps: 200, voidFeeBps: 100,
      strikePause: 300, strikeWindow: 300, settleGrace: 86_400, chainSideRatio: 1, depthPerBank: 2500n, gateDepth: 50n * 10n ** 18n,
    })
  })

  it('reads a round: times from roundTimes, raw and accepted sums and state from roundView', async () => {
    const r = await createRoundsClient(fakeClient(), ADDR, 0n).round(123n)
    expect(r).toMatchObject({
      roundId: 123n, pool: POOL, duration: 300, index: 7n,
      times: { openAt: 100, closeAt: 400, strikeStart: 700, strikeEnd: 1000, settleAt: 1300 },
      up: 30n, down: 20n, acceptedUp: 20n, acceptedDown: 20n, minBank: 20n, bookFinal: true, activated: true, outcome: 1,
    })
    // 0.398 gwei x 1e6 gas: the fee cover, not minBank, sets how big the round must be.
    expect(r.playFloor).toBe(activationFloor(20n, 398_000_000_000_000n))
    expect(r.playFloor > 20n).toBe(true)
  })

  it('reads a ticket, and a preview that reverts as "nothing yet"', async () => {
    const rc = createRoundsClient(fakeClient({ previewClaim: () => { throw new Error('NotSettled') } }), ADDR, 0n)
    expect(await rc.ticket(1n, PLAYER)).toEqual({ stake: 20n, side: 2, status: 1 })
    expect(await rc.previewClaim(1n, PLAYER)).toBeUndefined()
    expect(await createRoundsClient(fakeClient(), ADDR, 0n).previewClaim(1n, PLAYER)).toBe(39n)
  })

  it('finds a player\'s rounds from Bet events, once each, and their Claimed payouts', async () => {
    const logs = (req: any) =>
      req.event.name === 'Bet'
        ? [{ args: { roundId: 5n } }, { args: { roundId: 5n } }, { args: { roundId: 9n } }]
        : [{ args: { roundId: 9n, payout: 77n } }]
    const h = await createRoundsClient(fakeClient({}, logs), ADDR, 10n).history(PLAYER)
    expect(h.roundIds.map(String).sort()).toEqual(['5', '9'])
    expect(h.claimed.get('9')).toBe(77n)
    expect(h.scanError).toBeUndefined()
  })

  it('reads a pool\'s depth and the largest bank a round of it may reach now', async () => {
    expect(await createRoundsClient(fakeClient(), ADDR, 0n).poolDepth(POOL)).toEqual({ depth: 100n * 10n ** 18n, maxBank: 40_000_000_000_000_000n })
  })

  it('finds why a round was refunded from its RoundSettled event', async () => {
    const logs = (req: any) => (req.event.name === 'RoundSettled' && req.args.roundId === 7n ? [{ args: { roundId: 7n, reason: 4 } }] : [])
    const rc = createRoundsClient(fakeClient({}, logs), ADDR, 0n)
    expect(await rc.settleReason(7n)).toBe(4)
    expect(await rc.settleReason(8n)).toBeUndefined()
  })

  it('reports a failed log scan instead of throwing', async () => {
    const h = await createRoundsClient(fakeClient({}, () => { throw new Error('range too large') }), ADDR, 0n).history(PLAYER)
    expect(h).toMatchObject({ roundIds: [], scanError: 'range too large' })
  })

  it('lists only pools and durations the contract has switched on', async () => {
    const logs = () => [
      { eventName: 'PoolListed', args: { pool: OTHER } },
      { eventName: 'DurationSet', args: { duration: 900n } },
    ]
    const m = await createRoundsClient(fakeClient({}, logs), ADDR, 0n).markets([POOL], [300])
    expect(m.pools).toEqual([{ pool: POOL, wethIsToken0: false }])
    expect(m.durations).toEqual([300])
  })

  it('calls bet(roundId, stake, side, referrer) in the contract\'s order, and claim(roundId)', () => {
    const rc = createRoundsClient(fakeClient(), ADDR, 0n)
    const req = rc.betRequest(123n, 2, 10n, OTHER)
    expect(req).toMatchObject({ address: ADDR, functionName: 'bet', args: [123n, 10n, 2, OTHER] })
    // What the wallet would be asked to sign decodes to the named parameters.
    const item = POOL_ROUNDS_ABI.find((e) => e.type === 'function' && e.name === 'bet') as { inputs: readonly { name: string }[] }
    expect(item.inputs.map((i) => i.name)).toEqual(['roundId', 'stake', 'side', 'referrer'])
    const data = encodeFunctionData({ abi: POOL_ROUNDS_ABI, functionName: 'bet', args: req.args as never })
    expect(decodeFunctionData({ abi: POOL_ROUNDS_ABI, data }).args).toEqual([123n, 10n, 2, OTHER])
    expect(rc.claimRequest(123n)).toMatchObject({ functionName: 'claim', args: [123n] })
  })
})
