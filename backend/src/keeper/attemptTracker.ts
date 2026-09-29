/**
 * A memory of work that keeps coming back and never gets done.
 *
 * Two sweeps pick "the oldest N rows that are still unsettled" every tick:
 * resolveKeeper's overdue refund and the indexer's overdue-match reconcile.
 * A row that neither settles nor refunds - a match whose refund keeps
 * reverting, say - is the oldest one every single time, so it occupies a slot
 * on every tick forever, and once N such rows exist nothing newer is ever
 * reached (the failure the A03 fix already removed once for a different
 * cause).
 *
 * This counts attempts that made no progress per key. After `maxAttempts` in a
 * row the key is PARKED: callers leave it out of the next selection for
 * `cooldownMs`, then it gets exactly one more chance (a paused market gets
 * unpaused, an LP callback gets fixed) before being parked again. In memory
 * only, on purpose: a restart is a fresh look at everything, which is fine for
 * something that costs one read per row.
 */

export interface AttemptTrackerOptions {
  /** Attempts without progress before a key is parked. */
  maxAttempts: number
  /** How long a parked key stays out of the selection. */
  cooldownMs: number
  now?: () => number
}

export class AttemptTracker {
  private readonly attempts = new Map<string, number>()
  private readonly parkedUntil = new Map<string, number>()
  private readonly now: () => number

  constructor(private readonly opts: AttemptTrackerOptions) {
    this.now = opts.now ?? Date.now
  }

  /** The key for a match, the shape both sweeps use. */
  static keyOf(market: string, matchId: string | number | bigint): string {
    return `${market.toLowerCase()}:${matchId}`
  }

  /** Whether this key is parked right now. */
  isParked(key: string): boolean {
    const until = this.parkedUntil.get(key)
    if (until === undefined) return false
    if (this.now() >= until) {
      // Cooldown over: one more attempt, and a single failure parks it again.
      this.parkedUntil.delete(key)
      this.attempts.set(key, this.opts.maxAttempts - 1)
      return false
    }
    return true
  }

  /**
   * The keys to leave out of the next selection. Expired ones are released as
   * a side effect, so the map cannot grow without bound.
   */
  parkedKeys(): string[] {
    const out: string[] = []
    for (const key of [...this.parkedUntil.keys()]) {
      if (this.isParked(key)) out.push(key)
    }
    return out
  }

  /** This attempt made no progress. Returns true when it parked the key. */
  fail(key: string): boolean {
    const n = (this.attempts.get(key) ?? 0) + 1
    this.attempts.set(key, n)
    if (n >= this.opts.maxAttempts) {
      this.parkedUntil.set(key, this.now() + this.opts.cooldownMs)
      return true
    }
    return false
  }

  /** The key made progress or is gone: forget it. */
  clear(key: string): void {
    this.attempts.delete(key)
    this.parkedUntil.delete(key)
  }
}

/**
 * SQL for "not one of these keys", over `market_address` and `match_id`. Used
 * with the parked keys as `$n::text[]`; an empty array excludes nothing.
 */
export function notParkedSql(placeholder: string): string {
  return `(market_address || ':' || match_id::text) <> ALL(${placeholder}::text[])`
}
