/**
 * Plain-English text for what can go wrong when a trader claims, cancels,
 * refunds or recovers an order.
 *
 * lib/revertReasons.ts does the same for placeBet and is deliberately not
 * exhaustive; these are the require() strings of OrderbookMarket.claim,
 * cancelOrder, refundExpired and emergencyRefundMatch, which the bet form never
 * calls. Order is significant: the first entry whose key appears in the error
 * text wins, so keep the longer keys ahead of any key they contain.
 */
const ORDER_REVERT_REASONS: [string, string][] = [
  ['not your order', 'Only the wallet that placed this order can do that.'],
  ['already refunded', 'The unmatched part of this order was already returned.'],
  ['wrong status', 'This order is no longer open, so there is nothing left to cancel or refund.'],
  ['nothing to refund', 'Nothing to return: the whole order was matched.'],
  ['not expired', 'The 5-minute match window has not closed yet. Cancel the order to get the stake back now.'],
  ['settlements pending', 'Part of this order is still waiting for a result. Claim opens once every match has one.'],
  ['already claimed', 'This order was already claimed.'],
  ['not settled', 'This order is not ready to claim yet. If part of it is still waiting for a match, cancel the remainder first.'],
  ['nothing to claim', 'There is nothing to claim on this order.'],
  ['already settled', 'That match has already been settled, so there is nothing to recover.'],
  ['grace not over', 'Recovery opens 24 hours after the settlement time.'],
  ['match not found', 'That match does not exist.'],
]

/** Wallets word a refusal a dozen ways; viem gives most of them code 4001. */
export function isUserRejection(e: unknown): boolean {
  const err = e as { code?: number; name?: string; shortMessage?: string; message?: string } | undefined
  if (!err) return false
  if (err.code === 4001 || err.name === 'UserRejectedRequestError') return true
  const text = `${err.shortMessage ?? ''} ${err.message ?? ''}`.toLowerCase()
  return text.includes('user rejected') || text.includes('user denied') || text.includes('rejected the request')
}

/** Longest raw message shown when nothing above matched; viem's full text can run to pages. */
const MAX_RAW_LENGTH = 240

export function explainTxError(e: unknown, fallback = 'The transaction failed.'): string {
  if (isUserRejection(e)) return 'Cancelled in your wallet - nothing was sent.'

  const err = e as { shortMessage?: string; message?: string; details?: string } | undefined
  const haystack = [err?.shortMessage, err?.details, err?.message].filter(Boolean).join('\n')

  for (const [reason, friendly] of ORDER_REVERT_REASONS) {
    if (haystack.includes(reason)) return friendly
  }

  const raw = (err?.shortMessage || err?.message || '').trim()
  if (!raw) return fallback
  return raw.length > MAX_RAW_LENGTH ? `${raw.slice(0, MAX_RAW_LENGTH - 3)}...` : raw
}
