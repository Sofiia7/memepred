/**
 * The net result of one order, worked out from what the chain and the API
 * already say. Pure, so every rule is a test.
 *
 * Why it exists: the card said "payout 0.0198" and left the trader to subtract
 * the stake and guess what the fee was. A payout is not a profit, and on a mixed
 * order (one match won, one lost, one tied) nobody can do that sum in their
 * head. This is that sum.
 *
 * The rules, all of them from the contracts:
 *   - A match pairs two equal fills, so its pot is twice this order's share.
 *   - The winner is paid the pot less the fees (1% protocol, plus 1% to the LP
 *     vault when the vault took the other side). The payout already has them
 *     taken off; "fees" here is the difference, shown so it is not a surprise.
 *   - A loser gets nothing back and pays no fee: only the winner's pot is taxed.
 *   - A tie or a match nobody could price is refunded in full, no fee, at no
 *     gain and no loss.
 *   - The unmatched rest of an order is returned in full.
 *
 * Returns null whenever the inputs cannot be trusted to add up (a result still
 * pending, an unknown payout, a list of matches that does not sum to what the
 * order says it filled, a "win" whose payout is nowhere near a win's): a
 * receipt that might be wrong is worse than none.
 */
import type { MatchOutcome } from './orderModel'

/** What the receipt needs of one match: this order's share of it, and how it ended. */
export interface ReceiptMatch {
  /** Whole currency units. */
  amount: number
  outcome: MatchOutcome
}

export interface OrderReceipt {
  /** Stake that got a verdict: the matches that were won or lost. */
  atRisk: number
  /** Stake that came back unchanged: ties, matches nobody could price, the unmatched rest. */
  returned: number
  /** What the winning matches paid, after fees. 0 when nothing won. */
  payout: number
  /** Taken from the winners' pot before the payout. Already deducted from `payout`. */
  fees: number
  /** payout - atRisk: positive on a win, negative on a loss. */
  net: number
  /** net / atRisk, or null when nothing was at risk. */
  netPct: number | null
}

/** Floats parsed from NUMERIC strings and wei: differences below this are not real. */
const EPS = 1e-9

/**
 * A won match pays its pot less at most 2% (1% protocol cap, 1% LP taker), so
 * between 1.96x and 2x of this order's share. Well under that means the payout
 * on the order is not (yet) the sum of these wins - the same bound the
 * portfolio uses to tell a full win from a partial one.
 */
const MIN_WIN_RATIO = 1.9

export function buildReceipt(input: {
  /** The whole deposit. */
  amount: number
  /** What was matched. */
  filled: number
  /** Accrued winnings, or the amount actually paid once claimed. null = not known. */
  payout: number | null
  matches: readonly ReceiptMatch[]
}): OrderReceipt | null {
  const { amount, filled, payout, matches } = input

  if (payout === null || !Number.isFinite(payout) || payout < 0) return null
  if (!Number.isFinite(amount) || !Number.isFinite(filled) || filled < 0) return null
  if (matches.length === 0) return null
  if (matches.some((m) => m.outcome === 'pending' || !Number.isFinite(m.amount) || m.amount < 0)) return null

  // A list that does not add up to the fill is one that is still catching up.
  const total = matches.reduce((sum, m) => sum + m.amount, 0)
  if (Math.abs(total - filled) > EPS) return null

  let won = 0
  let lost = 0
  let back = 0
  for (const m of matches) {
    if (m.outcome === 'won') won += m.amount
    else if (m.outcome === 'lost') lost += m.amount
    else back += m.amount // tied, or refunded because it could not be priced
  }

  // A payout with no win behind it, or one bigger than the pot, is not data.
  if (won <= EPS && payout > EPS) return null
  if (won > EPS && payout < won * MIN_WIN_RATIO) return null
  const fees = won > EPS ? 2 * won - payout : 0
  if (fees < -EPS) return null

  const atRisk = won + lost
  const net = payout - atRisk
  return {
    atRisk,
    returned: back + Math.max(0, amount - filled),
    payout,
    fees: Math.max(0, fees),
    net,
    netPct: atRisk > EPS ? net / atRisk : null,
  }
}

/** 0.0198, 5, 0.00001: at most five decimals, no trailing zeros, no exponent. */
export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '-'
  const abs = Math.abs(n)
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 5
  const s = Number(n.toFixed(digits)).toString()
  return s === '-0' ? '0' : s
}

/** +0.0098, -0.01, 0. */
export function formatSigned(n: number): string {
  const s = formatAmount(n)
  if (s === '0') return s
  return n > 0 ? `+${s}` : s
}

/** +98%, -100%, 0%: one decimal only when it says something. */
export function formatPercent(ratio: number): string {
  const p = Number((ratio * 100).toFixed(1))
  if (p === 0) return '0%'
  return `${p > 0 ? '+' : ''}${p}%`
}
