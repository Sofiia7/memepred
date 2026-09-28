import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { OrderStatusCard, findStuckMatchId, MatchBreakdown } from './OrderStatusCard'
import { SETTLE_GRACE_SEC } from '../lib/contracts'

/**
 * The 24-hour escape hatch, tested at the level where it broke.
 *
 * `emergencyRefundMatch` is permissionless precisely so a dead keeper cannot
 * strand anyone's stake, and the button that calls it was written. It just
 * never rendered: useOrderStatus declared `settleAt` and never assigned it, so
 * the grace check compared against undefined and was false forever. Production
 * has already had a keeper die for 15 days once.
 *
 * Mocking wagmi rather than the hook is deliberate - a test that stubs
 * useOrderStatus would have passed against the broken code.
 */

const NOW = 1_800_000_000
const MARKET = '0x00000000000000000000000000000000000000aa' as const
const MATCH_ID = 7n

/** getMatch's settleAt, positioned relative to the 24h grace window. */
let settleAt = 0n
/**
 * The rest of getMatch's tie-relevant shape. Defaults match what used to be
 * hardcoded inline, so the two grace-period tests below are unaffected;
 * later tests override these to exercise a real win or an exact tie.
 */
let matchSettled = false
let matchEntryPrice = 1n
let matchExitPrice = 0n

const baseOrder = {
  trader:             '0x00000000000000000000000000000000000000bb',
  direction:          0,
  amount:             10_000_000n,
  filledAmount:       10_000_000n,
  referrer:           '0x0000000000000000000000000000000000000000',
  status:             1, // MATCHED
  placedAt:           BigInt(NOW - 90_000),
  matchId:            MATCH_ID,
  pendingSettlements: 1n,
  payout:             0n,
  unmatchedRefunded:  false,
}

/**
 * Mutable per-test order fixture, reassigned rather than mutated in place so
 * useOrderStatus's `useEffect([order])` sees a real change - the same way a
 * fresh wagmi read always hands back a new object, which is what makes its
 * "only capture a NONZERO payout" guard meaningful to test at all.
 */
let order: typeof baseOrder = { ...baseOrder }

vi.mock('wagmi', () => ({
  useWatchContractEvent: () => undefined,
  useReadContract: ({ functionName, query }: any) => {
    if (query?.enabled === false) return { data: undefined, refetch: vi.fn() }
    if (functionName === 'getOrder') return { data: order, refetch: vi.fn() }
    if (functionName === 'getMatch') {
      return {
        data: {
          upOrderId: 1n, downOrderId: 2n, amount: 10_000_000n,
          entryPrice: matchEntryPrice, settleAt, exitPrice: matchExitPrice,
          settled: matchSettled, upWon: false, lpMatch: false,
        },
        refetch: vi.fn(),
      }
    }
    return { data: undefined, refetch: vi.fn() }
  },
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW * 1000)
  order = { ...baseOrder }
  matchSettled = false
  matchEntryPrice = 1n
  matchExitPrice = 0n
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('OrderStatusCard, matched order awaiting settlement', () => {
  it('offers stake recovery once the settlement grace period has lapsed', () => {
    settleAt = BigInt(NOW - SETTLE_GRACE_SEC - 3600) // due 25 hours ago

    render(
      <OrderStatusCard
        marketAddress={MARKET}
        orderId={1n}
        onEmergencyRefund={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /recover my stake/i })).toBeDefined()
    expect(screen.queryByText(/awaiting market settlement/i)).toBeNull()
  })

  it('keeps waiting quietly while the match is merely overdue', () => {
    settleAt = BigInt(NOW - 3600) // due an hour ago, well inside the grace

    render(
      <OrderStatusCard
        marketAddress={MARKET}
        orderId={1n}
        onEmergencyRefund={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: /recover my stake/i })).toBeNull()
    expect(screen.getByText(/awaiting market settlement/i)).toBeDefined()
  })
})

describe('OrderStatusCard, claimed payout display', () => {
  /**
   * claim() zeroes order.payout on-chain BEFORE transferring (see
   * OrderbookMarket.sol's claim: `o.payout = 0` runs before the transfer),
   * and the card used to read order.payout fresh every time - so a claimed
   * order read back as "received 0 WETH", and ShareCard (fed the same value)
   * as "Just won 0 WETH". useOrderStatus's own payout state only updates on
   * a NONZERO read, so it holds the real amount after the on-chain value is
   * zeroed; the card now prefers that over the live value once the live
   * value is gone.
   */
  it('keeps showing the real payout after claim zeroes it on-chain', () => {
    // First render: SETTLED with a real, nonzero payout - a win, not a tie.
    order = { ...baseOrder, status: 2, pendingSettlements: 0n, payout: 5_000_000n }
    matchSettled = true
    matchEntryPrice = 1n
    matchExitPrice = 2n

    const { rerender } = render(
      <OrderStatusCard marketAddress={MARKET} orderId={1n} onClaim={vi.fn()} />,
    )
    expect(screen.getByText(/payout 5 USDC/)).toBeDefined()

    // claim() lands: the contract has zeroed payout and moved status to
    // CLAIMED. A fresh wagmi read is a new object, which is what actually
    // drives useOrderStatus's effect here (see `order`'s own comment above).
    order = { ...order, status: 3, payout: 0n }
    rerender(<OrderStatusCard marketAddress={MARKET} orderId={1n} onClaim={vi.fn()} />)

    expect(screen.getByText(/received 5 USDC/)).toBeDefined()
    expect(screen.queryByText(/received 0 USDC/)).toBeNull()
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
  it('shows a tie as a refund, not as a loss', () => {
    order = { ...baseOrder, status: 2, pendingSettlements: 0n, payout: 0n }
    matchSettled = true
    matchEntryPrice = 5n
    matchExitPrice = 5n // exact tie

    render(<OrderStatusCard marketAddress={MARKET} orderId={1n} />)

    expect(screen.getByText(/stake returned/i)).toBeDefined()
    expect(screen.queryByText(/loss/i)).toBeNull()
    expect(screen.queryByText(/you won/i)).toBeNull()
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
  it('offers Claim on a REFUNDED order that still has a real payout', () => {
    order = {
      ...baseOrder, status: 4 /* REFUNDED */, pendingSettlements: 0n,
      payout: 20_000_000n, filledAmount: 20_000_000n, amount: 20_000_000n,
    }

    render(<OrderStatusCard marketAddress={MARKET} orderId={1n} onClaim={vi.fn()} />)

    expect(screen.getByText(/refunded/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /claim 20 USDC/i })).toBeDefined()
  })

  it('does not offer Claim on a REFUNDED order with nothing left to claim', () => {
    order = { ...baseOrder, status: 4 /* REFUNDED */, pendingSettlements: 0n, payout: 0n }

    render(<OrderStatusCard marketAddress={MARKET} orderId={1n} />)

    expect(screen.queryByRole('button', { name: /claim/i })).toBeNull()
  })

  it('does not offer Claim while a different match on the order is still unsettled', () => {
    // pendingSettlements > 0: claim() itself would revert "settlements
    // pending" - this must never be offered regardless of payout.
    order = { ...baseOrder, status: 4 /* REFUNDED */, pendingSettlements: 1n, payout: 20_000_000n }

    render(<OrderStatusCard marketAddress={MARKET} orderId={1n} />)

    expect(screen.queryByRole('button', { name: /claim/i })).toBeNull()
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
})
