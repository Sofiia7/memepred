import { describe, it, expect } from 'vitest'
import { streaksFrom } from './streaks.js'

/** `true` = won. Oldest first, the order they settled in. */
const s = (...results: boolean[]) => streaksFrom(results)

describe('streaksFrom', () => {
  it('reports nothing for an address that has never settled a bet', () => {
    expect(s()).toEqual({ current: 0, max: 0 })
  })

  it('counts a run of wins', () => {
    expect(s(true, true, true)).toEqual({ current: 3, max: 3 })
  })

  it('resets the current streak on a loss but remembers the best one', () => {
    expect(s(true, true, true, false)).toEqual({ current: 0, max: 3 })
  })

  it('counts only the run still going, from the most recent bets', () => {
    expect(s(true, true, true, false, true, true)).toEqual({ current: 2, max: 3 })
  })

  it('takes the longest run when a later one is shorter', () => {
    expect(s(true, true, true, true, false, true)).toEqual({ current: 1, max: 4 })
  })

  it('handles a first bet that lost', () => {
    expect(s(false)).toEqual({ current: 0, max: 0 })
  })

  it('handles nothing but losses', () => {
    expect(s(false, false, false)).toEqual({ current: 0, max: 0 })
  })

  /**
   * The reason this is derived rather than incremented.
   *
   * A stored counter has to be advanced exactly once per settlement, in order.
   * The one that existed here was never called at all, so every streak badge
   * was unreachable; had it been called, a replayed event would have
   * double-counted and a missed one would have lost the run. Recomputing from
   * the settled orders cannot drift, and running it twice gives the same
   * answer.
   */
  it('is idempotent - the same history always gives the same answer', () => {
    const history = [true, false, true, true, true, false, true]
    expect(streaksFrom(history)).toEqual(streaksFrom(history))
    expect(streaksFrom(history)).toEqual({ current: 1, max: 3 })
  })
})
