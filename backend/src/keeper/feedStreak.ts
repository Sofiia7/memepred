/**
 * Consecutive-failure accounting for the oracle watchdog's auto-pause.
 *
 * Split out of oracleWatchdog.ts so the rule can be tested without standing up
 * redis and an RPC client.
 */

/** What one oracle ping told us about a feed. */
export type FeedPing =
  /** The feed answered with data. */
  | 'ok'
  /** The gateway answered, but not with a usable price for this feed. */
  | 'unavailable'
  /** We could not ask: our own credentials were rejected. Says nothing about the feed. */
  | 'unauthenticated'
  /** We could not ask: the gateway itself was unreachable. Says nothing about the feed. */
  | 'unreachable'

/** Consecutive failures before the watchdog pauses a feed on-chain. */
export const STALE_FAIL_LIMIT = Number(process.env.STALE_FAIL_LIMIT ?? '5')

/**
 * The fail streak after this tick.
 *
 * `unauthenticated` holds the streak instead of advancing it. When Hermes
 * closed to unauthenticated callers on 2026-08-26, every feed stopped
 * answering simultaneously - and treating that as feed staleness would have
 * had the watchdog pause every market we run. MarketFactory grants the keeper
 * pauseMarketsForFeed but deliberately withholds unpause, so recovering needs
 * the multisig to act on each market individually. A bad API key must not cost
 * that.
 *
 * Holding rather than clearing keeps an in-progress streak: while we cannot see
 * the feed, neither advancing nor forgiving is an honest reading.
 */
export function nextFailStreak(prev: number, ping: FeedPing): number {
  switch (ping) {
    case 'ok':              return 0
    case 'unavailable':     return prev + 1
    case 'unauthenticated': return prev
    case 'unreachable':     return prev
  }
}

/**
 * Whether this tick's results describe our side of the wire rather than any
 * particular feed.
 *
 * The per-feed streak cannot tell "this feed died" from "everything died": a
 * dead gateway advances every streak in lockstep, and about seven minutes later
 * the watchdog pauses every market we run over an outage in someone else's
 * infrastructure. Recovery is multisig-only, per market, by design.
 *
 * One feed stale while the others answer is the genuine feed-specific fault the
 * auto-pause exists for, and stays pausable. With a single feed configured the
 * aggregate carries no information at all - "the only feed is down" and
 * "everything is down" are the same observation - so it declines to guess and
 * leaves the per-feed rule in charge.
 */
export function isSystemicOutage(pings: FeedPing[]): boolean {
  return pings.length > 1 && pings.every((p) => p !== 'ok')
}
