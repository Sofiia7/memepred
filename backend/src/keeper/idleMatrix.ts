/**
 * Which market durations are worth keeping alive right now.
 *
 * The keeper rolls a fresh market for every (feed, duration) pair every
 * duration/2, which is 172800/duration creations per day per feed. The short
 * timeframes dominate completely:
 *
 *   300s     576/day     69% of all creations
 *   900s     192/day     23%
 *   3600s     48/day      6%
 *   14400s    12/day      1%
 *   86400s     2/day      0.2%
 *
 * All of it ran around the clock whether or not a single person was looking.
 * lib/activity.ts already taught the on-chain price recorder to tell the
 * difference and drop to a slow heartbeat when nobody is around; market
 * creation was the other half of the bill and never got the same treatment.
 * Measured on Base Sepolia 2026-08-28, creation was roughly half of a
 * 0.0105 ETH/day burn at zero users.
 *
 * The rule: while somebody is here, maintain everything. While nobody is,
 * maintain only durations at or above idleMinDurationSec - and, whatever the
 * threshold says, always at least the longest one, so a visitor never lands on
 * an empty board. The short markets come back within one keeper tick of the
 * first request that stamps the activity key.
 *
 * Kept as pure functions so the policy is testable without a chain or a clock.
 */

export interface IdleMatrixOptions {
  /** Below this, a duration is only maintained while a user is present. */
  idleMinDurationSec: number
  /** How long after the last request we still count somebody as here. */
  activityWindowMs: number
}

/** The default matrix, used by the savings assertion in the tests. */
export const ALL_DURATIONS_EXAMPLE = [300, 900, 3600, 14400, 86400]

/** Somebody made a real request recently enough to still count as here. */
export function isUserPresent(lastActivityMs: number | null, now: number, windowMs: number): boolean {
  return lastActivityMs !== null && now - lastActivityMs < windowMs
}

export function durationsToMaintain(
  all: number[],
  lastActivityMs: number | null,
  now: number,
  opts: IdleMatrixOptions,
): number[] {
  if (all.length === 0) return []

  if (isUserPresent(lastActivityMs, now, opts.activityWindowMs)) return [...all]

  const kept = all.filter(d => d >= opts.idleMinDurationSec)
  // Never return nothing. A misconfigured threshold should cost freshness, not
  // the entire product: the longest market stays open no matter what.
  return kept.length > 0 ? kept : [Math.max(...all)]
}

/** Markets roll at duration/2, so a day holds 172800/duration of them. */
export function creationsPerDay(durations: number[]): number {
  return durations.reduce((n, d) => n + Math.floor(172_800 / d), 0)
}
