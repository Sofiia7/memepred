import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { OrderStatusCard, findStuckMatchId, MatchBreakdown } from './OrderStatusCard'
import { MATCH_TIMEOUT_SEC, SETTLE_GRACE_SEC } from '../lib/contracts'

/**
 * The order card, tested at the level where it broke.
 *
 * `emergencyRefundMatch` is permissionless precisely so a dead keeper cannot
 * strand anyone's stake, and the button that calls it was written. It just
 * never rendered: useOrderStatus declared `settleAt` and never assigned it, so
 * the grace check compared against undefined and was false forever. Production
 * has already had a keeper die for 15 days once.
 *
 * Mocking wagmi rather than the hook is deliberate - a test that stubs
 * useOrderStatus would have passed against the broken code. The backend's
 * per-match endpoint is stubbed at fetch, for the same reason.
 *
 * Amounts read as whole USDC here (10_000_000n = "10"): the test environment
 * is the six-decimal Base Sepolia build.
 */

const NOW = 1_800_000_000
const MARKET = '0x00000000000000000000000000000000000000aa' as const
const TRADER = '0x00000000000000000000000000000000000000bb'
const STRANGER = '0x00000000000000000000000000000000000000cc'
const ZERO = '0x0000000000000000000000000000000000000000'
const MATCH_ID = 7n

const baseOrder = {
  trader:             TRADER,
  direction:          0,
  amount:             10_000_000n,
  filledAmount:       10_000_000n,
  referrer:           ZERO,
  status:             1, // MATCHED
  placedAt:           BigInt(NOW - 90_000),
  matchId:            MATCH_ID,
  pendingSettlements: 1n,
  payout:             0n,
  unmatchedRefunded:  false,
  expectedPrice:      1_000_000_000_000_000_000n,
  slippageBps:        100n,
}

/**
 * Mutable per-test fixtures, reassigned rather than mutated in place so
 * useOrderStatus's `useEffect([order])` sees a real change - the same way a
 * fresh wagmi read always hands back a new object, which is what makes its
 * "only capture a NONZERO payout" guard meaningful to test at all.
 */
let order: typeof baseOrder | undefined = { ...baseOrder }
let orderReadFailed = false
let account: string | undefined = TRADER
/** wagmi's account is undefined for a moment while it reconnects after a page load. */
let reconnecting = false

const chainMatch = (over: Record<string, unknown> = {}) => ({
  upOrderId: 1n, downOrderId: 2n, amount: 10_000_000n,
  entryPrice: 1n, settleAt: 0n, exitPrice: 0n,
  settled: false, upWon: false, lpMatch: false,
  ...over,
})
/** getMatch(id) as the chain answers it, by match id. */
let chainMatches: Record<string, ReturnType<typeof chainMatch>> = {}

/** What GET /api/markets/:address/orders/:orderId answers. */
type ApiMode = 'ok' | '404' | '500'
let apiMode: ApiMode = 'ok'
let apiRecord: Record<string, unknown> = { matches: [], payout: null }

/** What the Claimed log lookup finds. */
let claimedLogs: { args: { payout: bigint } }[] = []

const refetchSpy = vi.fn()

// One object for every render, like wagmi's own client: a fresh one per call
// would re-run every effect that lists the client as a dependency, forever.
const publicClient = { getLogs: async () => claimedLogs }

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: account, isReconnecting: reconnecting }),
  usePublicClient: () => publicClient,
  useWatchContractEvent: () => undefined,
  useReadContract: ({ functionName, args, query }: any) => {
    if (query?.enabled === false) return { data: undefined, refetch: refetchSpy, isLoading: false, isError: false }
    if (functionName === 'getOrder') {
      return { data: order, refetch: refetchSpy, isLoading: false, isError: orderReadFailed }
    }
    if (functionName === 'getMatch') {
      return { data: chainMatches[String(args[0])], refetch: refetchSpy, isLoading: false, isError: false }
    }
    return { data: undefined, refetch: refetchSpy, isLoading: false, isError: false }
  },
}))

/** Let promises (fetch, getLogs) settle and their state updates flush. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
}

async function renderCard(props: Partial<ComponentProps<typeof OrderStatusCard>> = {}) {
  const view = render(<OrderStatusCard marketAddress={MARKET} orderId={1n} {...props} />)
  await flush()
  return view
}

async function tick(seconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(seconds * 1000)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW * 1000)
  order = { ...baseOrder }
  orderReadFailed = false
  account = TRADER
  reconnecting = false
  chainMatches = { '7': chainMatch({ settleAt: BigInt(NOW + 3600) }) }
  apiMode = 'ok'
  apiRecord = { matches: [], payout: null }
  claimedLogs = []
  refetchSpy.mockClear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (apiMode === 'ok') return { ok: true, status: 200, json: async () => apiRecord }
      return { ok: false, status: apiMode === '404' ? 404 : 500, json: async () => ({}) }
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  cleanup()
})

describe('OrderStatusCard, matched order awaiting settlement', () => {
  it('offers stake recovery once the settlement grace period has lapsed', async () => {
    chainMatches['7'] = chainMatch({ settleAt: BigInt(NOW - SETTLE_GRACE_SEC - 3600) }) // due 25 hours ago
    const onEmergencyRefund = vi.fn()

    await renderCard({ onEmergencyRefund })

    const button = screen.getByRole('button', { name: /recover my stake/i })
    expect(button).toBeDefined()
    expect(screen.getByText(/more than 24 hours overdue/i)).toBeDefined()

    button.click()
    expect(onEmergencyRefund).toHaveBeenCalledWith(MATCH_ID)
  })

  it('keeps waiting quietly while the match is merely overdue, and says when Recover opens', async () => {
    chainMatches['7'] = chainMatch({ settleAt: BigInt(NOW - 3600) }) // due an hour ago, well inside the grace

    await renderCard({ onEmergencyRefund: vi.fn() })

    expect(screen.queryByRole('button', { name: /recover my stake/i })).toBeNull()
    expect(screen.getByText(/waiting for the keeper to post the result/i)).toBeDefined()
    expect(screen.getByText('Recover available in 23:00')).toBeDefined()
  })

  it('counts down to the result while the match is pending, and keeps counting', async () => {
    chainMatches['7'] = chainMatch({ settleAt: BigInt(NOW + 252) })

    await renderCard({ onEmergencyRefund: vi.fn() })
    expect(screen.getByText('Result in 04:12')).toBeDefined()

    await tick(1)
    expect(screen.getByText('Result in 04:11')).toBeDefined()

    // Past settleAt it turns into the keeper message instead of a negative timer.
    await tick(252)
    expect(screen.queryByText(/^Result in/)).toBeNull()
    expect(screen.getByText(/waiting for the keeper/i)).toBeDefined()
  })

  it('never offers Recover for a match that has already settled (the audit A04 P2)', async () => {
    // Match 7 settled a day and a half ago; the per-match list has not loaded.
    // The old fallback fired whenever the grace had lapsed, whatever the state.
    chainMatches['7'] = chainMatch({ settleAt: BigInt(NOW - 36 * 3600), settled: true, exitPrice: 2n })
    order = { ...baseOrder, pendingSettlements: 1n }
    apiMode = '404'

    await renderCard({ onEmergencyRefund: vi.fn() })

    expect(screen.queryByRole('button', { name: /recover my stake/i })).toBeNull()
    expect(screen.queryByText(/overdue/i)).toBeNull()
  })

  it('does not fall back to the first match once the list has loaded and nothing is stuck', async () => {
    // Match 1 settled a day ago, match 2 is still counting down: the card must
    // count down to match 2, not call match 1's settlement overdue and offer to
    // recover it (which reverts "already settled").
    chainMatches['7'] = chainMatch({ settleAt: BigInt(NOW - 36 * 3600), settled: true, exitPrice: 2n })
    apiRecord = {
      matches: [
        { matchId: '7', isLpMatch: false, amount: 5, settled: true, settleAt: NOW - 36 * 3600, outcome: 'won' },
        { matchId: '9', isLpMatch: false, amount: 5, settled: false, settleAt: NOW + 100, outcome: 'pending' },
      ],
      payout: null,
    }

    await renderCard({ onEmergencyRefund: vi.fn() })

    expect(screen.getByText('Result in 01:40')).toBeDefined()
    expect(screen.queryByRole('button', { name: /recover my stake/i })).toBeNull()
    expect(screen.queryByText(/overdue/i)).toBeNull()
  })

  it('offers Recover for a LATER match that is stuck while the first has settled', async () => {
    chainMatches['7'] = chainMatch({ settleAt: BigInt(NOW - SETTLE_GRACE_SEC - 7200), settled: true, exitPrice: 2n })
    apiRecord = {
      matches: [
        { matchId: '7', isLpMatch: false, amount: 5, settled: true, settleAt: NOW - SETTLE_GRACE_SEC - 7200, outcome: 'won' },
        { matchId: '9', isLpMatch: false, amount: 5, settled: false, settleAt: NOW - SETTLE_GRACE_SEC - 3600, outcome: 'pending' },
      ],
      payout: null,
    }
    const onEmergencyRefund = vi.fn()

    await renderCard({ onEmergencyRefund })

    screen.getByRole('button', { name: /recover my stake/i }).click()
    expect(onEmergencyRefund).toHaveBeenCalledWith(9n)
  })

  it('says the LP vault took the other side from the chain, not from an event', async () => {
    chainMatches['7'] = chainMatch({ settleAt: BigInt(NOW + 60), lpMatch: true })
    await renderCard()
    expect(screen.getByText(/matched with lp vault/i)).toBeDefined()
  })
})

describe('OrderStatusCard, an order still looking for a match', () => {
  const searching = () => ({
    ...baseOrder, status: 0, filledAmount: 0n, pendingSettlements: 0n, matchId: 0n, placedAt: BigInt(NOW - 100),
  })

  it('says how long the match window has left and that cancelling is free', async () => {
    order = searching()
    await renderCard({ onCancel: vi.fn() })

    expect(screen.getByText(/searching for a match/i)).toBeDefined()
    expect(screen.getByText('03:20 until the match window closes')).toBeDefined()
    expect(screen.getByText(/cancel any time to get the full 10 USDC back/i)).toBeDefined()
    expect(screen.getByText(/refunded automatically/i)).toBeDefined()
  })

  it('lets the trader cancel right away, before the 5 minute window is over', async () => {
    order = searching()
    const onCancel = vi.fn()
    await renderCard({ onCancel, onRefund: vi.fn() })

    const cancel = screen.getByRole('button', { name: /cancel remaining 10 usdc/i })
    expect(screen.queryByRole('button', { name: /refund unmatched portion/i })).toBeNull()
    cancel.click()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('adds the permissionless refund once the window has closed, and keeps Cancel', async () => {
    order = searching()
    const onRefund = vi.fn()
    await renderCard({ onCancel: vi.fn(), onRefund })

    await tick(MATCH_TIMEOUT_SEC - 100 + 1) // strictly past placedAt + timeout, like the contract

    expect(screen.getByText('Match window closed')).toBeDefined()
    screen.getByRole('button', { name: /refund unmatched portion/i }).click()
    expect(onRefund).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /cancel remaining 10 usdc/i })).toBeDefined()
  })

  it('does not offer the refund one second early (the contract says "not expired")', async () => {
    order = searching()
    await renderCard({ onRefund: vi.fn() })

    await tick(MATCH_TIMEOUT_SEC - 100)

    expect(screen.queryByRole('button', { name: /refund unmatched portion/i })).toBeNull()
  })

  it('shows Cancel only to the order\'s trader', async () => {
    order = searching()
    account = STRANGER
    await renderCard({ onCancel: vi.fn() })
    expect(screen.queryByRole('button', { name: /cancel remaining/i })).toBeNull()
    expect(screen.getByText(/only that wallet can claim or cancel/i)).toBeDefined()
    cleanup()

    account = undefined
    await renderCard({ onCancel: vi.fn() })
    expect(screen.queryByRole('button', { name: /cancel remaining/i })).toBeNull()
    expect(screen.getByText(/connect that wallet/i)).toBeDefined()
  })
})

describe('OrderStatusCard, a partly filled order', () => {
  const partial = (over: Record<string, unknown> = {}) => ({
    ...baseOrder, status: 0, filledAmount: 4_000_000n, pendingSettlements: 1n, placedAt: BigInt(NOW - 100), ...over,
  })

  it('separates what is running from what is still waiting', async () => {
    order = partial()
    chainMatches['7'] = chainMatch({ settleAt: BigInt(NOW + 200) })

    await renderCard({ onCancel: vi.fn() })

    expect(screen.getByText(/partly matched/i)).toBeDefined()
    expect(screen.getByText(/4 of 10 USDC matched/)).toBeDefined()
    expect(screen.getByText('Result in 03:20')).toBeDefined()
    expect(screen.getByText(/6 USDC still waiting for a match/)).toBeDefined()
    expect(screen.getByRole('button', { name: /cancel remaining 6 usdc/i })).toBeDefined()
    expect(screen.queryByText(/searching for a match/i)).toBeNull()
  })

  it('explains why Claim is not open when the filled part already won, and offers cancel', async () => {
    // The matched part settled and won 7; 6 USDC is still resting in the book.
    order = partial({ pendingSettlements: 0n, payout: 7_000_000n })
    chainMatches['7'] = chainMatch({ settleAt: BigInt(NOW - 60), settled: true, exitPrice: 2n })
    const onCancel = vi.fn()

    await renderCard({ onCancel, onClaim: vi.fn() })

    expect(screen.getByText(/claim is not available yet/i)).toBeDefined()
    expect(screen.getByText(/cancel the remainder or wait for the automatic refund, then claim/i)).toBeDefined()
    expect(screen.queryByRole('button', { name: /^claim/i })).toBeNull()
    screen.getByRole('button', { name: /cancel remaining 6 usdc/i }).click()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('opens Claim once the tail has been returned', async () => {
    order = partial({ pendingSettlements: 0n, payout: 7_000_000n, unmatchedRefunded: true })
    chainMatches['7'] = chainMatch({ settleAt: BigInt(NOW - 60), settled: true, exitPrice: 2n })

    await renderCard({ onClaim: vi.fn() })

    expect(screen.getByRole('button', { name: /claim 7 usdc/i })).toBeDefined()
    expect(screen.queryByText(/claim is not available yet/i)).toBeNull()
  })

  it('a tail returned while matches are still pending is not "searching" any more', async () => {
    order = partial({ unmatchedRefunded: true })
    chainMatches['7'] = chainMatch({ settleAt: BigInt(NOW + 60) })

    await renderCard({ onCancel: vi.fn() })

    expect(screen.queryByText(/searching for a match/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /cancel remaining/i })).toBeNull()
    expect(screen.getByText('Result in 01:00')).toBeDefined()
  })
})

describe('OrderStatusCard, who may claim', () => {
  const settledWinner = () => ({ ...baseOrder, status: 2, pendingSettlements: 0n, payout: 5_000_000n })

  it('offers Claim to the order\'s trader', async () => {
    order = settledWinner()
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    await renderCard({ onClaim: vi.fn() })
    expect(screen.getByRole('button', { name: /claim 5 usdc/i })).toBeDefined()
  })

  it('does not offer Claim to whoever opened a shared link (claim() would revert)', async () => {
    order = settledWinner()
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    account = STRANGER
    await renderCard({ onClaim: vi.fn() })
    expect(screen.queryByRole('button', { name: /claim/i })).toBeNull()
    expect(screen.getByText(/only that wallet can claim or cancel/i)).toBeDefined()
  })

  it('does not tell the trader to connect while the wallet is still reconnecting after a page load', async () => {
    order = settledWinner()
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    account = undefined
    reconnecting = true
    await renderCard({ onClaim: vi.fn() })
    expect(screen.queryByText(/connect that wallet/i)).toBeNull()
    expect(screen.queryByText(/only that wallet can claim or cancel/i)).toBeNull()
  })

  it('nor to a visitor with no wallet connected', async () => {
    order = settledWinner()
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    account = undefined
    await renderCard({ onClaim: vi.fn() })
    expect(screen.queryByRole('button', { name: /claim/i })).toBeNull()
    expect(screen.getByText(/connect that wallet/i)).toBeDefined()
  })
})

describe('OrderStatusCard, claimed payout display', () => {
  /**
   * claim() zeroes order.payout on-chain BEFORE transferring (see
   * OrderbookMarket.sol's claim: `o.payout = 0` runs before the transfer),
   * and the card used to read order.payout fresh every time - so a claimed
   * order read back as "received 0 WETH", and ShareCard (fed the same value)
   * as "Just won 0 WETH". The amount now comes from the last nonzero live read
   * of THIS order, the backend's stored payout or the Claimed log, in that
   * order, and is shown as unknown - never as zero - when none is available.
   */
  it('keeps showing the real payout after claim zeroes it on-chain', async () => {
    // First render: SETTLED with a real, nonzero payout - a win, not a tie.
    order = { ...baseOrder, status: 2, pendingSettlements: 0n, payout: 5_000_000n }
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })

    const { rerender } = await renderCard({ onClaim: vi.fn() })
    expect(screen.getByText(/payout 5 USDC/)).toBeDefined()

    // claim() lands: the contract has zeroed payout and moved status to
    // CLAIMED. A fresh wagmi read is a new object, which is what actually
    // drives useOrderStatus's effect here (see `order`'s own comment above).
    order = { ...order, status: 3, payout: 0n }
    rerender(<OrderStatusCard marketAddress={MARKET} orderId={1n} onClaim={vi.fn()} />)
    await flush()

    expect(screen.getByText(/received 5 USDC/)).toBeDefined()
    expect(screen.queryByText(/received 0 USDC/)).toBeNull()
  })

  it('shows the real amount after a RELOAD, from the backend, not 0 (audit U04)', async () => {
    // Nothing was captured this session: the page opens on an already CLAIMED order.
    order = { ...baseOrder, status: 3, pendingSettlements: 0n, payout: 0n }
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    apiRecord = { matches: [], payout: 0.0196 }

    await renderCard()

    expect(screen.getByText(/received 0\.0196 USDC/)).toBeDefined()
    expect(screen.queryByText(/received 0 USDC/)).toBeNull()
  })

  it('falls back to the Claimed log when the backend does not know the order', async () => {
    order = { ...baseOrder, status: 3, pendingSettlements: 0n, payout: 0n }
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    apiMode = '404'
    claimedLogs = [{ args: { payout: 7_000_000n } }]

    await renderCard()

    expect(screen.getByText(/received 7 USDC/)).toBeDefined()
  })

  it('says the amount is unavailable rather than claiming it was 0', async () => {
    order = { ...baseOrder, status: 3, pendingSettlements: 0n, payout: 0n }
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    apiMode = '500'
    claimedLogs = []

    await renderCard()

    expect(screen.getByText(/payout amount unavailable/i)).toBeDefined()
    expect(screen.queryByText(/received 0/i)).toBeNull()
  })

  it('does not carry one order\'s payout into the next order\'s card (audit U04)', async () => {
    order = { ...baseOrder, status: 2, pendingSettlements: 0n, payout: 5_000_000n }
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    const { rerender } = await renderCard({ onClaim: vi.fn() })
    expect(screen.getByText(/payout 5 USDC/)).toBeDefined()

    // React Router does not remount across a param change: same component,
    // different order, which has been claimed and whose payout nothing knows.
    order = { ...baseOrder, status: 3, pendingSettlements: 0n, payout: 0n }
    apiMode = '404'
    rerender(<OrderStatusCard marketAddress={MARKET} orderId={2n} onClaim={vi.fn()} />)
    await flush()

    expect(screen.queryByText(/received 5 USDC/)).toBeNull()
    expect(screen.getByText(/payout amount unavailable/i)).toBeDefined()
  })
})

describe('OrderStatusCard, a tied match', () => {
  /**
   * A match settling exactly at its entry price refunds both stakes
   * (OrderbookMarket._refundTiedMatch) instead of paying either side. It
   * never touches Order.payout, so `won = payout > 0n` alone read this as a
   * loss - the card fell through to "Loss - better luck next time" for a
   * trader who lost nothing.
   */
  it('shows a tie as a refund, not as a loss', async () => {
    order = { ...baseOrder, status: 2, pendingSettlements: 0n, payout: 0n }
    chainMatches['7'] = chainMatch({ settled: true, entryPrice: 5n, exitPrice: 5n }) // exact tie

    await renderCard()

    expect(screen.getByText(/stake returned/i)).toBeDefined()
    expect(screen.queryByText(/loss/i)).toBeNull()
    expect(screen.queryByText(/you won/i)).toBeNull()
  })
})

describe('OrderStatusCard, one word for the whole order (audit U08)', () => {
  const settled = () => ({ ...baseOrder, status: 2, pendingSettlements: 0n, payout: 4_000_000n })
  const m = (matchId: string, outcome: string) => ({
    matchId, isLpMatch: false, amount: 5, settled: true, settleAt: NOW - 100, outcome,
  })

  it('calls an order that won one match and lost another MIXED, not "You won"', async () => {
    order = settled()
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    apiRecord = { matches: [m('7', 'won'), m('8', 'lost')], payout: null }

    await renderCard()

    expect(screen.getByText('Mixed result')).toBeDefined()
    expect(screen.queryByText(/you won/i)).toBeNull()
    expect(screen.getByText(/filled across 2 matches/i)).toBeDefined()
  })

  it('still says "You won" when every match won', async () => {
    order = settled()
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    apiRecord = { matches: [m('7', 'won'), m('8', 'won')], payout: null }

    await renderCard()

    expect(screen.getByText(/you won/i)).toBeDefined()
  })

  it('a later win is not hidden behind a tied first match', async () => {
    order = settled()
    chainMatches['7'] = chainMatch({ settled: true, entryPrice: 5n, exitPrice: 5n })
    apiRecord = { matches: [m('7', 'tied'), m('8', 'won')], payout: null }

    await renderCard({ onClaim: vi.fn() })

    expect(screen.getByText('Mixed result')).toBeDefined()
    expect(screen.getByRole('button', { name: /claim 4 usdc/i })).toBeDefined()
  })
})

describe('OrderStatusCard, audit A04 (2026-09-28): claim survives a forced REFUNDED status', () => {
  /**
   * The exact scenario AuditCases.t.sol's
   * test_Audit_RefundedOrderCanStillHaveClaimableWinnings proves on chain:
   * one match won, a later one was emergency-refunded, and the contract
   * forces order.status to REFUNDED regardless of the order's own fill
   * state or its accumulated payout. The old REFUNDED branch never checked
   * payout at all.
   */
  it('offers Claim on a REFUNDED order that still has a real payout', async () => {
    order = {
      ...baseOrder, status: 4 /* REFUNDED */, pendingSettlements: 0n,
      payout: 20_000_000n, filledAmount: 20_000_000n, amount: 20_000_000n,
    }

    await renderCard({ onClaim: vi.fn() })

    expect(screen.getByText(/refunded/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /claim 20 USDC/i })).toBeDefined()
  })

  it('does not offer Claim on a REFUNDED order with nothing left to claim', async () => {
    order = { ...baseOrder, status: 4 /* REFUNDED */, pendingSettlements: 0n, payout: 0n }

    await renderCard()

    expect(screen.queryByRole('button', { name: /claim/i })).toBeNull()
  })

  it('does not offer Claim while a different match on the order is still unsettled', async () => {
    // pendingSettlements > 0: claim() itself would revert "settlements
    // pending" - this must never be offered regardless of payout.
    order = { ...baseOrder, status: 4 /* REFUNDED */, pendingSettlements: 1n, payout: 20_000_000n }

    await renderCard()

    expect(screen.queryByRole('button', { name: /claim/i })).toBeNull()
  })
})

describe('OrderStatusCard, refunds say why', () => {
  it('a match the resolver could not price: both sides got their stake back, no fee', async () => {
    order = { ...baseOrder, status: 4 /* REFUNDED */, pendingSettlements: 0n, payout: 0n }
    apiRecord = {
      matches: [{ matchId: '7', isLpMatch: false, amount: 10, settled: true, settleAt: NOW - 60, outcome: 'emergency_refunded' }],
      payout: null,
    }

    await renderCard()

    expect(screen.getByText('↩ Refunded (no price available)')).toBeDefined()
    expect(screen.getByText(/both sides got their stake back with no fee/i)).toBeDefined()
  })

  it('an order nothing ever matched was simply returned', async () => {
    order = { ...baseOrder, status: 4, filledAmount: 0n, pendingSettlements: 0n, matchId: 0n, payout: 0n, unmatchedRefunded: true }

    await renderCard()

    expect(screen.getByText('↩ Refunded')).toBeDefined()
    expect(screen.getByText(/no match was found for this order/i)).toBeDefined()
    expect(screen.queryByText(/no price available/i)).toBeNull()
  })
})

describe('OrderStatusCard, an order that is not there', () => {
  it('says it is loading while the read is in flight', async () => {
    order = undefined
    await renderCard()
    expect(screen.getByText(/loading order/i)).toBeDefined()
  })

  it('says so, with a Retry, when the read failed', async () => {
    order = undefined
    orderReadFailed = true
    await renderCard()
    expect(screen.getByText(/couldn't load this order/i)).toBeDefined()
    screen.getByRole('button', { name: /retry/i }).click()
    expect(refetchSpy).toHaveBeenCalled()
  })

  it('an id nobody used (a zeroed struct) is "Order not found", not a card full of zeros', async () => {
    order = { ...baseOrder, trader: ZERO, amount: 0n, filledAmount: 0n, status: 0, matchId: 0n, pendingSettlements: 0n }
    await renderCard()
    expect(screen.getByText('Order not found')).toBeDefined()
    expect(screen.queryByText(/searching for a match/i)).toBeNull()
  })
})

describe('OrderStatusCard, refreshing after a transaction', () => {
  it('refetches the order, the match and the breakdown when the refresh signal changes', async () => {
    const { rerender } = await renderCard({ refreshSignal: 0 })
    refetchSpy.mockClear()
    const fetchMock = vi.mocked(fetch)
    const before = fetchMock.mock.calls.length

    rerender(<OrderStatusCard marketAddress={MARKET} orderId={1n} refreshSignal={1} />)
    await flush()

    expect(refetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2) // getOrder and getMatch
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before)    // the per-match breakdown
  })
})

describe('findStuckMatchId (audit A04, 2026-09-28)', () => {
  const NOW = 1_800_000_000

  it('finds a later match that is actually stuck, not just the first one', () => {
    const matches = [
      { matchId: '7', settled: true, settleAt: NOW - 3600 },
      { matchId: '9', settled: false, settleAt: NOW - SETTLE_GRACE_SEC - 3600 },
    ]
    expect(findStuckMatchId(matches, NOW)).toBe(9n)
  })

  it('returns undefined when nothing has actually passed grace yet', () => {
    const matches = [{ matchId: '9', settled: false, settleAt: NOW - 3600 }]
    expect(findStuckMatchId(matches, NOW)).toBeUndefined()
  })

  it('returns undefined once every match has settled', () => {
    const matches = [
      { matchId: '7', settled: true, settleAt: NOW - SETTLE_GRACE_SEC - 3600 },
      { matchId: '9', settled: true, settleAt: NOW - SETTLE_GRACE_SEC - 3600 },
    ]
    expect(findStuckMatchId(matches, NOW)).toBeUndefined()
  })
})

describe('MatchBreakdown (audit A04, 2026-09-28)', () => {
  it('renders nothing for a single-match order - nothing to reconcile', () => {
    const { container } = render(
      <MatchBreakdown matches={[{ matchId: '1', amount: 0.01, outcome: 'won' }]} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('lists every match with its own outcome once there is more than one', () => {
    render(
      <MatchBreakdown
        matches={[
          { matchId: '1', amount: 0.01, outcome: 'tied' },
          { matchId: '2', amount: 0.01, outcome: 'won' },
        ]}
      />,
    )
    expect(screen.getByText(/tied - refunded/i)).toBeDefined()
    expect(screen.getByText(/won/i)).toBeDefined()
  })

  it('labels a refunded match "no price available" and explains it in one line', () => {
    render(
      <MatchBreakdown
        matches={[
          { matchId: '1', amount: 0.01, outcome: 'emergency_refunded' },
          { matchId: '2', amount: 0.01, outcome: 'won' },
        ]}
      />,
    )
    expect(screen.getByText(/refunded \(no price available\)/i)).toBeDefined()
    expect(screen.getByText(/both sides got their stake back with no fee/i)).toBeDefined()
    expect(screen.queryByText(/emergency/i)).toBeNull()
  })
})

describe('OrderStatusCard, the net result receipt', () => {
  /**
   * A payout is not a profit. The card said "payout 19.8" and left the trader
   * to subtract the stake and guess the fee. The receipt is that sum, for every
   * shape an order can end in - and says nothing when it cannot be sure.
   * (Six-decimal build: 10_000_000n is "10".)
   */
  const settled = (payout: bigint) => ({ ...baseOrder, status: 2, pendingSettlements: 0n, payout })
  const m = (matchId: string, outcome: string, amount = 10) => ({
    matchId, isLpMatch: false, amount, settled: true, settleAt: NOW - 100, outcome,
  })

  it('a win: what was staked, what was paid, the fee already taken off, and the profit', async () => {
    order = settled(19_800_000n)
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    apiRecord = { matches: [m('7', 'won')], payout: null }

    await renderCard()

    expect(screen.getByRole('group', { name: /net result/i })).toBeDefined()
    expect(screen.getByText('Staked and settled')).toBeDefined()
    expect(screen.getByText('Fees, already taken off')).toBeDefined()
    expect(screen.getByText('0.2 USDC')).toBeDefined()
    expect(screen.getByText('+9.8 USDC (+98%)')).toBeDefined()
  })

  it('a loss is the whole stake', async () => {
    order = settled(0n)
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    apiRecord = { matches: [m('7', 'lost')], payout: null }

    await renderCard()

    expect(screen.getByText('-10 USDC (-100%)')).toBeDefined()
    expect(screen.queryByText('Fees, already taken off')).toBeNull()
  })

  it('reads the same result from the chain alone when the backend is down', async () => {
    order = settled(19_800_000n)
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    apiMode = '500'

    await renderCard()

    expect(screen.getByText('+9.8 USDC (+98%)')).toBeDefined()
  })

  it('a win and a loss on one order net against each other, and a tied match comes back', async () => {
    // Won 10 (paid 19.8), lost 10, tied 5: at risk 20, returned 5, net -0.2.
    order = { ...settled(19_800_000n), amount: 25_000_000n, filledAmount: 25_000_000n }
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    apiRecord = { matches: [m('7', 'won'), m('8', 'lost'), m('9', 'tied', 5)], payout: null }

    await renderCard()

    expect(screen.getByText('Mixed result')).toBeDefined()
    expect(screen.getByText('Also returned to you in full')).toBeDefined()
    expect(screen.getByText('-0.2 USDC (-1%)')).toBeDefined()
  })

  it('a claimed order shows it too, from the amount the backend remembers', async () => {
    order = { ...baseOrder, status: 3, pendingSettlements: 0n, payout: 0n }
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    apiRecord = { matches: [m('7', 'won')], payout: 19.8 }

    await renderCard()

    expect(screen.getByText(/received 19.8 USDC/)).toBeDefined()
    expect(screen.getByText('+9.8 USDC (+98%)')).toBeDefined()
  })

  it('says nothing for a claimed order whose paid amount cannot be found', async () => {
    order = { ...baseOrder, status: 3, pendingSettlements: 0n, payout: 0n }
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    apiMode = '404'

    await renderCard()

    expect(screen.getByText(/payout amount unavailable/i)).toBeDefined()
    expect(screen.queryByText('Net result')).toBeNull()
  })

  it('says nothing for a tie: the headline already says the stake came back', async () => {
    order = settled(0n)
    chainMatches['7'] = chainMatch({ settled: true, entryPrice: 5n, exitPrice: 5n })
    apiRecord = { matches: [m('7', 'tied')], payout: null }

    await renderCard()

    expect(screen.queryByText('Net result')).toBeNull()
  })

  it('says nothing while the backend list is behind the chain (a match missing from it)', async () => {
    order = { ...settled(19_800_000n), amount: 20_000_000n, filledAmount: 20_000_000n }
    chainMatches['7'] = chainMatch({ settled: true, exitPrice: 2n })
    apiRecord = { matches: [m('7', 'won')], payout: null } // 10 of the 20 filled

    await renderCard()

    expect(screen.queryByText('Net result')).toBeNull()
  })

  it('is not shown on an order that is still running', async () => {
    order = { ...baseOrder }
    apiRecord = { matches: [m('7', 'pending')], payout: null }

    await renderCard()

    expect(screen.queryByText('Net result')).toBeNull()
  })
})
