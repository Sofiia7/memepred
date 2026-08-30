import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { OrderStatusCard } from './OrderStatusCard'
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

const order = {
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

vi.mock('wagmi', () => ({
  useWatchContractEvent: () => undefined,
  useReadContract: ({ functionName, query }: any) => {
    if (query?.enabled === false) return { data: undefined, refetch: vi.fn() }
    if (functionName === 'getOrder') return { data: order, refetch: vi.fn() }
    if (functionName === 'getMatch') {
      return {
        data: {
          upOrderId: 1n, downOrderId: 2n, amount: 10_000_000n,
          entryPrice: 1n, settleAt, exitPrice: 0n,
          settled: false, upWon: false, lpMatch: false,
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
