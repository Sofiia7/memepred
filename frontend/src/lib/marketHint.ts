/**
 * What to say while the short markets are missing from the board.
 *
 * The keeper does not maintain 5m and 15m markets while nobody is around: they
 * are ~92% of all market creations and the reason the gas bill is small. The
 * cost is a cold start - the first visitor after a quiet spell lands on a board
 * carrying 1h/4h/24h and none of the short markets the product is about.
 *
 * Measured end to end on 2026-08-30: 81 seconds. Up to 30s for the keeper's
 * create loop, ~10s for the transaction, up to 45s for the indexer to pick it
 * up. That wait is acceptable. A wait with nothing on screen explaining it is
 * not - it reads as a broken product rather than a cold start.
 *
 * Kept as a pure function rather than inline JSX so the three states can be
 * tested without a rendering library, which is also how the rest of lib/ is
 * tested here.
 */

/** Anything below the keeper's idle floor (IDLE_MIN_DURATION_SEC, 1h). */
export const SHORT_MAX_SEC = 3600

/**
 * When the wait stops being described as normal.
 *
 * Roughly twice the measured cold start. Past that, something is actually
 * wrong, and a screen that keeps promising markets are opening would be the
 * same lie this project has already paid for once: a reassuring page over a
 * dead keeper.
 */
export const SLOW_AFTER_MS = 150_000

export interface MarketLike {
  status:   string
  duration: number
}

export interface Hint {
  text: string
  slow: boolean
}

/**
 * @param markets      everything the API returned
 * @param waitingForMs how long the short markets have been missing, or null
 * @returns the line to show, or null when there is nothing to explain
 */
export function shortMarketHint(markets: MarketLike[], waitingForMs: number | null): Hint | null {
  const open = markets.filter((m) => m.status === 'OPEN')

  // An empty board is a different message entirely and the page already has
  // one. This hint is only for the case where markets exist but the short ones
  // are missing, which is the cold start rather than an outage.
  if (open.length === 0) return null
  if (open.some((m) => m.duration < SHORT_MAX_SEC)) return null

  const slow = waitingForMs !== null && waitingForMs > SLOW_AFTER_MS
  return {
    slow,
    text: slow
      ? 'Short markets are taking longer than usual to open'
      : 'Opening 5m and 15m markets - about a minute',
  }
}
