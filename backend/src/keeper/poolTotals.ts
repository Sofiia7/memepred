/**
 * How much money actually sits on each side of a market.
 *
 * `markets.up_pool` / `down_pool` have existed since 001_init.sql and nothing
 * has ever written them - the only `UPDATE markets` statements in the backend
 * are the two status flips (indexer.markResolvedMarkets, marketCreator.
 * closeExpiredMarkets). They therefore read 0 for every market forever, which
 * was invisible until you follow where they go: priceRecorder copies them into
 * `prob_snapshots` every tick, and /api/candles/:market/prob-history serves
 * that as the odds history chart. The chart is a flat 50% line by
 * construction, on a market with real money on both sides.
 *
 * Split out of the indexer for the same reason as refundEligibility: the rule
 * has edge cases worth stating once and testing, and none of them need a
 * database to decide.
 *
 * Not to be confused with the live percentage in the UI, which reads
 * `getPendingDepth` on-chain and is deliberately a different quantity - the
 * unmatched queue, labelled "queue" in the composer. This is staked money.
 */

/** The `orders` columns that decide how much of an order is still committed. */
export interface PoolOrderRow {
  marketAddress:     string
  direction:         'UP' | 'DOWN' | string
  /** Total deposit, immutable after placeBet. */
  amountUsdc:        number
  /** Matched so far; the unmatched tail is `amountUsdc - filledAmount`. */
  filledAmount:      number
  status:            string
  /** The tail has already been returned by refundExpired. */
  unmatchedRefunded: boolean
}

export interface Pools { up: number; down: number }

/**
 * Money still committed by one order.
 *
 * REFUNDED means the whole deposit went back. `unmatchedRefunded` means only
 * the tail did, and the order keeps its MATCHED/SETTLED status - so status
 * alone cannot answer this.
 */
function committed(o: PoolOrderRow): number {
  if (o.status === 'REFUNDED') return 0
  return o.unmatchedRefunded ? o.filledAmount : o.amountUsdc
}

/** Staked USDC per side, keyed by market address. Markets with no orders are absent. */
export function poolTotals(rows: PoolOrderRow[]): Map<string, Pools> {
  const out = new Map<string, Pools>()
  for (const o of rows) {
    let p = out.get(o.marketAddress)
    if (!p) { p = { up: 0, down: 0 }; out.set(o.marketAddress, p) }
    const amount = committed(o)
    if (o.direction === 'UP') p.up += amount
    else                     p.down += amount
  }
  return out
}
