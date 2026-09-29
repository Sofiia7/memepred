/**
 * What the portfolio says about each bet, from the fields /api/profile serves.
 *
 * Pure, and kept apart from Portfolio.tsx so each label is a test. Two rules of
 * the old page were wrong in ways users could see: an order counted as "WON" as
 * soon as ONE of its matches won (a loss on the rest, or a refund, did not
 * matter), and "Ready to claim" listed only orders whose status was SETTLED, so
 * a REFUNDED order that still held winnings from another match (audit A04) was
 * never offered.
 */

export type BetStatus = 'PENDING' | 'MATCHED' | 'SETTLED' | 'CLAIMED' | 'REFUNDED'

/** The fields of a profile row these rules read. Amounts arrive as NUMERIC strings. */
export interface BetLike {
  order_id: string | null
  amount_usdc: string
  filled_amount?: string | null
  payout_usdc: string | null
  status: BetStatus
  /** Tri-state: null while the order is running, then whether ANY match won. */
  won: boolean | null
  /** Whether ANY match tied. */
  tied?: boolean | null
  claimed: boolean
  /** Not served by every backend build; only ever used to rule a cancel out. */
  unmatched_refunded?: boolean | null
}

export type BetOutcome = 'open' | 'win' | 'loss' | 'tie' | 'mixed' | 'refunded'

export const BET_OUTCOME_LABEL: Record<BetOutcome, string> = {
  open: 'OPEN',
  win: 'WIN',
  loss: 'LOSS',
  tie: 'TIE',
  mixed: 'MIXED',
  refunded: 'REFUNDED',
}

/**
 * A fully won order pays 2x its stake less at most 2% (the protocol fee is
 * capped at 1%, the LP taker fee is 1%), so between 1.96x and 2x. Anything that
 * won but paid clearly less than that lost or refunded part of what it staked.
 */
const FULL_WIN_RATIO = 1.9

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function betPayout(b: Pick<BetLike, 'payout_usdc'>): number | null {
  return num(b.payout_usdc)
}

export function betStake(b: Pick<BetLike, 'amount_usdc'>): number {
  return num(b.amount_usdc) ?? 0
}

/** What actually went to risk: the filled part, or the deposit when the API does not say. */
export function betAtRisk(b: Pick<BetLike, 'amount_usdc' | 'filled_amount'>): number {
  return num(b.filled_amount) ?? betStake(b)
}

/**
 * win / loss / tie / mixed / refunded / open.
 *
 * `won` and `tied` say whether ANY match won or tied, which is not enough alone:
 * "won and not tied" covers an order that won everything and one that won one
 * match and lost another. The payout tells them apart, because a full win pays
 * about twice the stake (see FULL_WIN_RATIO) and a partial one clearly less.
 */
export function betOutcome(b: BetLike): BetOutcome {
  if (b.status === 'PENDING' || b.status === 'MATCHED') return 'open'

  const payout = betPayout(b) ?? 0

  // Forced to REFUNDED by one refunded match. With winnings still on the order
  // the rest of it won something, so it is not simply "refunded".
  if (b.status === 'REFUNDED') return payout > 0 ? 'mixed' : 'refunded'

  if (b.won === true) {
    if (b.tied === true) return 'mixed'
    const atRisk = betAtRisk(b)
    if (payout > 0 && atRisk > 0 && payout < atRisk * FULL_WIN_RATIO) return 'mixed'
    return 'win'
  }
  if (b.tied === true) return 'tie'
  if (b.won === false) return 'loss'
  // SETTLED or CLAIMED with no verdict yet: the indexer is behind.
  return 'open'
}

/**
 * Whether the row belongs under "Ready to claim". Mirrors what claim() will
 * accept as far as the API can tell: winnings on the order, none already paid.
 * REFUNDED counts as long as it still has a payout (audit A04).
 */
export function isClaimableBet(b: BetLike): boolean {
  if (!b.order_id || b.claimed || b.status === 'CLAIMED') return false
  const payout = betPayout(b)
  if (b.status === 'SETTLED') return payout !== null ? payout > 0 : b.won === true
  if (b.status === 'REFUNDED') return payout !== null && payout > 0
  return false
}

/**
 * The part of a running order that is still waiting for a match, in currency
 * units, or 0. An order that is PENDING or MATCHED with filled < amount has a
 * tail that can be cancelled, unless the API says it was already returned.
 */
export function betUnmatched(b: BetLike): number {
  if (!b.order_id) return 0
  if (b.status !== 'PENDING' && b.status !== 'MATCHED') return 0
  if (b.unmatched_refunded === true) return 0
  // No fill figure means no evidence of a tail. Guessing "the whole deposit"
  // would offer a cancel on every fully matched order that lacks the field.
  const filled = num(b.filled_amount)
  if (filled === null) return 0
  const rest = betStake(b) - filled
  // NUMERIC strings parsed to floats: 0.01 - 0.01 must not read as dust.
  return rest > 1e-9 ? rest : 0
}
