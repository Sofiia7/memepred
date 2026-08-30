/**
 * Whether an on-chain order's unmatched stake is refundable right now.
 *
 * Split out of refundExpired.ts so the rule can be tested without an RPC client,
 * and so it can be read side by side with the contract it has to agree with.
 *
 * The keeper was deciding this with a rule that predated the multi-fill
 * refactor: PENDING only, no notion of a partial fill, no idempotency flag. It
 * therefore never returned the unmatched tail of a partially filled order, and
 * re-sent refunds for tails it had already returned.
 */

/** OrderbookMarket.OrderStatus, in declaration order. */
export const OrderStatus = {
  PENDING:  0,
  MATCHED:  1,
  SETTLED:  2,
  CLAIMED:  3,
  REFUNDED: 4,
} as const

export type OrderStatusValue = (typeof OrderStatus)[keyof typeof OrderStatus]

/** The fields of OrderbookMarket.Order that decide refundability. */
export interface OnchainOrder {
  status:            number
  /** Total deposit, immutable after placeBet. */
  amount:            bigint
  /** Matched so far; the unmatched tail is `amount - filledAmount`. */
  filledAmount:      bigint
  placedAt:          bigint
  /** The contract's idempotency flag: the tail has already been returned. */
  unmatchedRefunded: boolean
}

/**
 * Mirrors the require() chain in OrderbookMarket.refundExpired. Kept in the
 * same order as the contract so the two can be diffed by eye.
 *
 * A false here must mean the transaction would revert; every true we get wrong
 * is a reverted transaction billed to the keeper wallet.
 */
export function isRefundable(
  order: OnchainOrder,
  now: bigint,
  matchTimeout: bigint,
): boolean {
  if (order.unmatchedRefunded) return false
  if (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.MATCHED) return false
  if (now <= order.placedAt + matchTimeout) return false
  return order.amount > order.filledAmount
}
