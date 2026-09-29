import { andMarketInFactory, currentFactory } from '../lib/marketScope.js'

/**
 * SQL for how long, in whole seconds, the oldest DUE and still unresolved match
 * has been waiting since it came due (0 when there is none).
 *
 * stale_settlements is the older, coarser cousin: it only shows a match once it
 * is five minutes late, which is the right bar for "settlement has stopped" and
 * far too late for "the keeper is slower than the pool's price history". A pool
 * that trades every second keeps only about 300 seconds of observations, and
 * the resolver refunds a match whose exit window has fallen out of them, so a
 * due match that waits much longer than two minutes is a match that may be
 * refunded instead of settled. This reads `matches` directly to see it early.
 *
 * Bounded above by the contract's 24h SETTLE_GRACE plus the same hour of slack
 * stale_settlements uses: past that a match is emergencyRefundMatch's job, and
 * one that never resolves would otherwise hold this number high forever.
 *
 * The projection can be a tick or two behind the chain (a match settled a
 * moment ago that the indexer has not seen yet still reads unsettled), so this
 * is a warning signal and is sized to be one.
 *
 * On rhc only the current factory's markets count: the keeper does not act on
 * an earlier deployment's, so a match left there is not a lag.
 */
export function readyMatchLagQuery(factory: string | null = currentFactory()): string {
  return `SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(settle_at))), 0)::int AS lag
            FROM matches
           WHERE settled = FALSE
             AND settle_at <= NOW()
             AND settle_at > NOW() - INTERVAL '25 hours'${andMarketInFactory('market_address', factory)}`
}
