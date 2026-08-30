import { describe, it, expect } from 'vitest'
import { isRefundable, OrderStatus, type OnchainOrder } from './refundEligibility.js'

const TIMEOUT = 300n  // MATCH_TIMEOUT, 5 minutes

/** A fully unmatched order placed at t=1000, expired by default. */
const order = (over: Partial<OnchainOrder> = {}): OnchainOrder => ({
  status:            OrderStatus.PENDING,
  amount:            10_000_000n,   // 10 USDC
  filledAmount:      0n,
  placedAt:          1000n,
  unmatchedRefunded: false,
  ...over,
})

/** Comfortably past placedAt + MATCH_TIMEOUT. */
const EXPIRED = 1000n + TIMEOUT + 1n

describe('isRefundable', () => {
  it('refunds a fully unmatched order once the match timeout has passed', () => {
    expect(isRefundable(order(), EXPIRED, TIMEOUT)).toBe(true)
  })

  it('does not refund before the timeout has elapsed', () => {
    expect(isRefundable(order(), 1000n + TIMEOUT, TIMEOUT)).toBe(false)
  })

  /**
   * The bug this module exists for, half one.
   *
   * The keeper only ever looked at PENDING orders. An order that found a
   * counterparty for part of its size is MATCHED, and the contract still owes
   * the trader the part that never filled - `refundExpired` explicitly supports
   * it (`amount - filledAmount`, status PENDING *or* MATCHED). Nobody was
   * returning that tail.
   */
  it('refunds the unmatched tail of a partially filled order', () => {
    const partial = order({ status: OrderStatus.MATCHED, filledAmount: 4_000_000n })
    expect(isRefundable(partial, EXPIRED, TIMEOUT)).toBe(true)
  })

  it('does not refund an order that filled completely', () => {
    const full = order({ status: OrderStatus.MATCHED, filledAmount: 10_000_000n })
    expect(isRefundable(full, EXPIRED, TIMEOUT)).toBe(false)
  })

  /**
   * The bug this module exists for, half two.
   *
   * `unmatchedRefunded` is the contract's idempotency flag and it did not exist
   * in the ABI the keeper was decoding with. Without it the keeper re-sends
   * refunds for tails it already returned; each one reverts with "already
   * refunded" and bills gas on a chain where that is real money.
   */
  it('does not refund a tail that was already returned', () => {
    const done = order({ status: OrderStatus.MATCHED, filledAmount: 4_000_000n, unmatchedRefunded: true })
    expect(isRefundable(done, EXPIRED, TIMEOUT)).toBe(false)
  })

  it.each([
    ['SETTLED', OrderStatus.SETTLED],
    ['CLAIMED', OrderStatus.CLAIMED],
    ['REFUNDED', OrderStatus.REFUNDED],
  ])('does not refund a %s order', (_label, status) => {
    expect(isRefundable(order({ status }), EXPIRED, TIMEOUT)).toBe(false)
  })

  it('agrees with the contract on the exact expiry boundary', () => {
    // Solidity: require(block.timestamp > o.placedAt + MATCH_TIMEOUT)
    const boundary = 1000n + TIMEOUT
    expect(isRefundable(order(), boundary,      TIMEOUT)).toBe(false)
    expect(isRefundable(order(), boundary + 1n, TIMEOUT)).toBe(true)
  })
})
