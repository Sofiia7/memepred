import { describe, it, expect } from 'vitest'
import { nextFailStreak, isSystemicOutage, STALE_FAIL_LIMIT, type FeedPing } from './feedStreak.js'

/** Feed the watchdog N ticks of the same ping result and report the streak. */
const run = (ping: FeedPing, ticks: number, from = 0) => {
  let streak = from
  for (let i = 0; i < ticks; i++) streak = nextFailStreak(streak, ping)
  return streak
}

describe('nextFailStreak', () => {
  it('clears the streak when the feed answers', () => {
    expect(nextFailStreak(4, 'ok')).toBe(0)
  })

  it('advances the streak while the feed is unreachable', () => {
    expect(nextFailStreak(0, 'unavailable')).toBe(1)
    expect(nextFailStreak(1, 'unavailable')).toBe(2)
  })

  it('reaches the auto-pause limit on a genuinely dead feed', () => {
    expect(run('unavailable', STALE_FAIL_LIMIT)).toBeGreaterThanOrEqual(STALE_FAIL_LIMIT)
  })

  /**
   * The reason this function exists.
   *
   * When Hermes closed to unauthenticated callers on 2026-08-26, every feed
   * started failing to ping at once. Counting that toward the streak would have
   * had the watchdog call pauseMarketsForFeed on every feed we run - and the
   * factory grants the keeper pause but deliberately not unpause, so undoing it
   * needs the multisig to act on each market individually. A missing or wrong
   * API key must never cost a multisig ceremony.
   */
  it('never auto-pauses a feed because our own credentials are broken', () => {
    expect(run('unauthenticated', STALE_FAIL_LIMIT * 5)).toBeLessThan(STALE_FAIL_LIMIT)
  })

  it('holds an in-progress streak rather than losing it when credentials break', () => {
    // We cannot observe the feed at all, so neither advancing nor forgiving is
    // honest. Freeze, and pick the count back up when we can see again.
    expect(nextFailStreak(2, 'unauthenticated')).toBe(2)
  })

  it('resumes counting from the held streak once the key is fixed and the feed is still down', () => {
    let streak = run('unavailable', 2)
    streak = run('unauthenticated', 10, streak)
    expect(nextFailStreak(streak, 'unavailable')).toBe(3)
  })

  /**
   * Same guarantee, the failure that actually happens now.
   *
   * The gateway being unreachable - DNS, timeout, a 502 - says nothing about
   * any individual feed, and it fails every feed at once. Counting it would
   * auto-pause the entire product over a blip in someone else's infrastructure,
   * and the factory grants the keeper pause but deliberately not unpause.
   */
  it('never auto-pauses because we could not reach the gateway', () => {
    expect(run('unreachable', STALE_FAIL_LIMIT * 5)).toBeLessThan(STALE_FAIL_LIMIT)
  })
})

/**
 * The per-feed streak cannot tell "this feed died" from "everything died",
 * because a dead gateway advances every feed's streak in lockstep. One feed
 * going stale while the others answer is a real, feed-specific fault worth
 * pausing that market for. All of them going at once is our side of the wire,
 * and pausing every market over it is a self-inflicted outage that only the
 * multisig can undo, market by market.
 */
describe('isSystemicOutage', () => {
  it('calls it systemic when no feed answered', () => {
    expect(isSystemicOutage(['unavailable', 'unavailable'])).toBe(true)
    expect(isSystemicOutage(['unreachable', 'unavailable', 'unreachable'])).toBe(true)
  })

  it('is not systemic while any feed still answers', () => {
    expect(isSystemicOutage(['unavailable', 'ok'])).toBe(false)
  })

  it('is not systemic on a healthy board', () => {
    expect(isSystemicOutage(['ok', 'ok'])).toBe(false)
  })

  /**
   * With one feed configured the aggregate carries no information - "the only
   * feed is down" and "everything is down" are the same observation. Fall back
   * to the per-feed rule rather than inventing a reading; a genuinely dead
   * single feed still needs to be pausable.
   */
  it('will not guess from a single feed', () => {
    expect(isSystemicOutage(['unavailable'])).toBe(false)
    expect(isSystemicOutage([])).toBe(false)
  })
})
