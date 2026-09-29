import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { useOrderStatus } from './useOrderStatus'

/**
 * What useOrderStatus watches, polls and reports.
 *
 * The event watcher used to be four inline lambdas: wagmi lists `onLogs` in its
 * effect's dependencies, so every render (and the card re-renders every second
 * for its countdown) tore each filter down and installed a new one. And the
 * MatchSettled/MatchTied watchers compared against order.matchId alone, so a
 * multi-fill order heard about its first match settling and none of the rest.
 */

const MARKET = '0x00000000000000000000000000000000000000aa' as const
const TRADER = '0x00000000000000000000000000000000000000bb'

const order = (over: Record<string, unknown> = {}) => ({
  trader: TRADER, direction: 0, amount: 10n, filledAmount: 10n, referrer: TRADER, status: 1,
  placedAt: 1n, matchId: 7n, pendingSettlements: 2n, payout: 0n, unmatchedRefunded: false,
  expectedPrice: 1n, slippageBps: 100n, ...over,
})

let orderData: ReturnType<typeof order> | undefined
let matchData: Record<string, unknown> | undefined
let apiBody: unknown
let claimedLogs: { args: { payout: bigint } }[]
let readCalls: { functionName: string; query: any; args: unknown[] }[]
let watchCalls: { onLogs: (logs: unknown[]) => void; enabled?: boolean; address: string }[]
const refetchOrder = vi.fn()
const refetchMatch = vi.fn()
const client = { getLogs: async () => claimedLogs }

vi.mock('wagmi', () => ({
  useReadContract: ({ functionName, args, query }: any) => {
    readCalls.push({ functionName, query, args })
    if (query?.enabled === false) return { data: undefined, refetch: vi.fn() }
    if (functionName === 'getOrder') return { data: orderData, refetch: refetchOrder, isLoading: false, isError: false }
    return { data: matchData, refetch: refetchMatch }
  },
  useWatchContractEvent: (params: any) => {
    watchCalls.push(params)
  },
  usePublicClient: () => client,
}))

function Probe({ id = 1n }: { id?: bigint }) {
  const s = useOrderStatus(MARKET, id)
  return (
    <div data-testid="state">
      {JSON.stringify({
        status: s.status,
        payout: s.payout?.toString() ?? null,
        matches: s.matches.map((m) => m.matchId),
        lp: s.isLpMatch,
        tied: s.isTied,
        settleAt: s.settleAt ?? null,
      })}
    </div>
  )
}

const state = () => JSON.parse(screen.getByTestId('state').textContent as string)
const lastWatch = () => watchCalls[watchCalls.length - 1]

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 15))
  })
}

beforeEach(() => {
  orderData = order()
  matchData = { upOrderId: 1n, downOrderId: 0n, amount: 5n, entryPrice: 1n, settleAt: 1_800_000_000n, exitPrice: 0n, settled: false, upWon: false, lpMatch: false }
  apiBody = { matches: [], payout: null }
  claimedLogs = []
  readCalls = []
  watchCalls = []
  refetchOrder.mockClear()
  refetchMatch.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => apiBody })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

describe('useOrderStatus: the event watcher', () => {
  it('hands wagmi the SAME callback on every render, so the filter is not rebuilt each time', async () => {
    const { rerender } = render(<Probe />)
    await flush()
    rerender(<Probe />)
    rerender(<Probe />)

    expect(watchCalls.length).toBeGreaterThan(2)
    const first = watchCalls[0].onLogs
    expect(watchCalls.every((c) => c.onLogs === first)).toBe(true)
  })

  it('watches the whole market once (no per-event watchers), and only for a real order', async () => {
    render(<Probe />)
    await flush()
    expect(lastWatch().address).toBe(MARKET)
    expect(lastWatch().enabled).toBe(true)
    expect('eventName' in lastWatch()).toBe(false)

    cleanup()
    watchCalls = []
    render(<Probe id={0n} />)
    expect(lastWatch().enabled).toBe(false)
  })

  const fire = (...logs: { eventName: string; args: Record<string, unknown> }[]) => {
    refetchOrder.mockClear()
    refetchMatch.mockClear()
    act(() => lastWatch().onLogs(logs))
  }
  const refetched = () => refetchOrder.mock.calls.length > 0 && refetchMatch.mock.calls.length > 0

  it.each([
    ['OrderMatched with this order as the UP side', { eventName: 'OrderMatched', args: { matchId: 9n, upId: 1n, downId: 4n } }],
    ['OrderMatched with this order as the DOWN side', { eventName: 'OrderMatched', args: { matchId: 9n, upId: 5n, downId: 1n } }],
    ['LPMatched for this order', { eventName: 'LPMatched', args: { matchId: 9n, orderId: 1n } }],
    ['OrderRefunded for this order (a cancel, an expiry, a refund)', { eventName: 'OrderRefunded', args: { orderId: 1n } }],
    ['Claimed for this order', { eventName: 'Claimed', args: { orderId: 1n, payout: 5n } }],
    ['MatchSettled for its first match', { eventName: 'MatchSettled', args: { matchId: 7n } }],
    ['MatchTied for its first match', { eventName: 'MatchTied', args: { matchId: 7n } }],
    ['MatchRefunded for its first match (the resolver refund)', { eventName: 'MatchRefunded', args: { matchId: 7n } }],
  ])('refetches on %s', async (_name, log) => {
    render(<Probe />)
    await flush()
    fire(log)
    expect(refetched()).toBe(true)
  })

  it('also refetches when a LATER match of the same order settles (the old watcher missed these)', async () => {
    apiBody = {
      matches: [
        { matchId: '7', isLpMatch: false, amount: 1, settled: true, settleAt: 1, outcome: 'won' },
        { matchId: '9', isLpMatch: false, amount: 1, settled: false, settleAt: 2, outcome: 'pending' },
      ],
      payout: null,
    }
    render(<Probe />)
    await flush()
    expect(state().matches).toEqual(['7', '9'])

    fire({ eventName: 'MatchSettled', args: { matchId: 9n } })
    expect(refetched()).toBe(true)
  })

  it.each([
    ['another order being matched', { eventName: 'OrderMatched', args: { matchId: 9n, upId: 5n, downId: 6n } }],
    ['another order being refunded', { eventName: 'OrderRefunded', args: { orderId: 2n } }],
    ['another order being claimed', { eventName: 'Claimed', args: { orderId: 2n, payout: 1n } }],
    ['another market match settling', { eventName: 'MatchSettled', args: { matchId: 99n } }],
    ['an event it does not know', { eventName: 'Paused', args: {} }],
  ])('ignores %s', async (_name, log) => {
    render(<Probe />)
    await flush()
    fire(log)
    expect(refetchOrder).not.toHaveBeenCalled()
    expect(refetchMatch).not.toHaveBeenCalled()
  })

  it('reacts to a batch of logs once, not once per log', async () => {
    render(<Probe />)
    await flush()
    fire(
      { eventName: 'MatchSettled', args: { matchId: 7n } },
      { eventName: 'Claimed', args: { orderId: 1n, payout: 5n } },
    )
    expect(refetchOrder).toHaveBeenCalledTimes(1)
  })
})

describe('useOrderStatus: polling', () => {
  it('polls the order every 5 seconds until it is claimed', async () => {
    render(<Probe />)
    await flush()
    const interval = readCalls.find((c) => c.functionName === 'getOrder')!.query.refetchInterval
    expect(interval({ state: { data: { status: 1 } } })).toBe(5_000)
    expect(interval({ state: { data: undefined } })).toBe(5_000)
    expect(interval({ state: { data: { status: 3 } } })).toBe(false)
  })

  it('reads the first match only once the order has one', async () => {
    orderData = order({ matchId: 0n })
    render(<Probe />)
    await flush()
    const match = readCalls.filter((c) => c.functionName === 'getMatch')
    expect(match.every((c) => c.query.enabled === false)).toBe(true)
  })
})

describe('useOrderStatus: what it reports', () => {
  it.each([
    [0, 'pending'], [1, 'matched'], [2, 'settled'], [3, 'claimed'], [4, 'refunded'],
  ])('order status %s is "%s"', async (code, name) => {
    orderData = order({ status: code })
    render(<Probe />)
    await flush()
    expect(state().status).toBe(name)
  })

  it('knows the LP vault took the other side from the chain, so it survives a reload', async () => {
    matchData = { ...matchData!, lpMatch: true }
    render(<Probe />)
    await flush()
    expect(state().lp).toBe(true)
  })

  it('reports the first match\'s settleAt and a tie when it settled at its entry price', async () => {
    matchData = { ...matchData!, settled: true, entryPrice: 5n, exitPrice: 5n }
    render(<Probe />)
    await flush()
    expect(state().settleAt).toBe(1_800_000_000)
    expect(state().tied).toBe(true)
  })

  it('a match that has not settled is not a tie, whatever its (zero) exit price says', async () => {
    matchData = { ...matchData!, settled: false, entryPrice: 0n, exitPrice: 0n }
    render(<Probe />)
    await flush()
    expect(state().tied).toBe(false)
  })

  it('reports the live payout while there is one', async () => {
    orderData = order({ status: 2, payout: 5n, pendingSettlements: 0n })
    render(<Probe />)
    await flush()
    expect(state().payout).toBe('5')
  })

  it('a claimed order with nothing to go on has no payout - unknown, not zero', async () => {
    orderData = order({ status: 3, payout: 0n, pendingSettlements: 0n })
    render(<Probe />)
    await flush()
    expect(state().payout).toBeNull()
  })
})
