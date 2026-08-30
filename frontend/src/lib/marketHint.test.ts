import { describe, it, expect } from 'vitest'
import { shortMarketHint, SLOW_AFTER_MS } from './marketHint'

const m = (duration: number, status = 'OPEN') => ({ status, duration })

/** The idle board, as read from Postgres on 2026-08-30 while nobody was around. */
const IDLE_BOARD = [m(3600), m(3600), m(14400), m(14400), m(86400), m(86400)]

describe('shortMarketHint', () => {
  it('explains the wait when only long markets are up', () => {
    expect(shortMarketHint(IDLE_BOARD, 5_000)).toEqual({
      slow: false,
      text: 'Opening 5m and 15m markets - about a minute',
    })
  })

  it('says nothing once a short market is on the board', () => {
    expect(shortMarketHint([...IDLE_BOARD, m(300)], 5_000)).toBeNull()
  })

  it('counts 15m as short too', () => {
    expect(shortMarketHint([...IDLE_BOARD, m(900)], 5_000)).toBeNull()
  })

  /**
   * The state this exists for. A cold start is 81 seconds; a keeper that has
   * died is forever. A message that keeps promising markets are opening would
   * be a reassuring screen over a dead product, which is the exact failure this
   * codebase has already paid for once.
   */
  it('stops promising once the wait stops being normal', () => {
    const hint = shortMarketHint(IDLE_BOARD, SLOW_AFTER_MS + 1)

    expect(hint).toEqual({
      slow: true,
      text: 'Short markets are taking longer than usual to open',
    })
  })

  it('is still reassuring right up to the threshold', () => {
    expect(shortMarketHint(IDLE_BOARD, SLOW_AFTER_MS)?.slow).toBe(false)
  })

  it('treats a not-yet-started wait as normal rather than slow', () => {
    expect(shortMarketHint(IDLE_BOARD, null)?.slow).toBe(false)
  })

  /**
   * An empty board is an outage, not a cold start, and the page has its own
   * message for it. Two competing explanations on one screen is worse than
   * either alone.
   */
  it('defers to the empty-board message when there is nothing at all', () => {
    expect(shortMarketHint([], 5_000)).toBeNull()
  })

  it('ignores closed markets when deciding what is on the board', () => {
    const closedShort = [...IDLE_BOARD, m(300, 'CLOSED'), m(900, 'RESOLVED')]

    expect(shortMarketHint(closedShort, 5_000)?.text).toMatch(/Opening 5m/)
  })

  it('does not offer a hint when only closed markets exist', () => {
    expect(shortMarketHint([m(3600, 'CLOSED')], 5_000)).toBeNull()
  })
})
