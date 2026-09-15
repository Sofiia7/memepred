/**
 * Short, plain-English text for the revert reasons a bet can actually hit.
 *
 * Composer used to slice any error message to ~30 characters, so "price
 * slippage exceeded", "expectedPrice zero" and an ERC20 balance error all
 * rendered as the same unhelpful truncated prefix - none of them readable,
 * and none of them distinguishable from each other.
 *
 * Sourced from contracts/src/OrderbookMarket.sol's own require(...) strings -
 * specifically the ones placeBet can actually revert with, since that is the
 * only call this maps errors for. PoolOrderbookMarket inherits placeBet
 * unchanged and adds no requires of its own beyond _getCurrentPrice's
 * "non-positive price". Deliberately not exhaustive: settle/claim/refund
 * have their own revert strings (see the same file), but Composer never
 * triggers those calls.
 */
const KNOWN_REVERT_REASONS: Record<string, string> = {
  'below min':               'Stake is below the minimum bet.',
  'above max':               'Stake is above the maximum bet.',
  'self referral':           "You can't use your own referral link.",
  'expectedPrice zero':      "Price hasn't loaded yet - try again.",
  'price slippage exceeded': 'The price moved before this confirmed - try again.',
  'non-positive price':      "Couldn't read a valid price right now - try again.",
}

/**
 * Maps a caught error's message to short plain English when it matches a
 * known contract revert reason. Anything else - a wallet rejection, an ERC20
 * balance/allowance error, a network failure - is returned in full rather
 * than guessing at a friendlier phrasing for it or truncating it.
 */
export function friendlyRevertReason(message: string | undefined): string {
  if (!message) return ''
  for (const [reason, friendly] of Object.entries(KNOWN_REVERT_REASONS)) {
    if (message.includes(reason)) return friendly
  }
  return message
}
