import { describe, it, expect } from 'vitest'
import { durationsToMaintain, isUserPresent, creationsPerDay, ALL_DURATIONS_EXAMPLE } from './idleMatrix.js'

const NOW  = Date.parse('2026-08-28T12:00:00Z')
const MIN  = 60_000
const ALL  = [300, 900, 3600, 14400, 86400]

const opts = { idleMinDurationSec: 3600, activityWindowMs: 15 * MIN }

describe('which durations to keep alive', () => {
  it('keeps everything while somebody is here', () => {
    expect(durationsToMaintain(ALL, NOW - 2 * MIN, NOW, opts)).toEqual(ALL)
  })

  /**
   * The whole point. A 5-minute market rolls every 150 seconds, which is 576
   * creations a day per feed - 69% of every market this keeper has ever made,
   * paid for around the clock whether or not a single person is looking.
   */
  it('drops the short timeframes once nobody has been here for the window', () => {
    expect(durationsToMaintain(ALL, NOW - 20 * MIN, NOW, opts)).toEqual([3600, 14400, 86400])
  })

  it('treats a never-seen visitor as idle', () => {
    expect(durationsToMaintain(ALL, null, NOW, opts)).toEqual([3600, 14400, 86400])
  })

  it('comes back the moment someone arrives', () => {
    expect(durationsToMaintain(ALL, NOW - 16 * MIN, NOW, opts)).not.toContain(300)
    expect(durationsToMaintain(ALL, NOW, NOW, opts)).toContain(300)
  })

  /**
   * A visitor must never land on an empty site. Whatever the thresholds are set
   * to, the longest duration always stays alive - there is always something to
   * bet on, it is just not the 5-minute one until somebody shows up.
   */
  it('never empties the board, however the threshold is configured', () => {
    const absurd = { idleMinDurationSec: 999_999_999, activityWindowMs: 15 * MIN }
    expect(durationsToMaintain(ALL, null, NOW, absurd)).toEqual([86400])
  })

  it('handles a single-duration configuration without dropping it', () => {
    expect(durationsToMaintain([300], null, NOW, opts)).toEqual([300])
  })

  it('leaves an empty configuration empty rather than inventing one', () => {
    expect(durationsToMaintain([], null, NOW, opts)).toEqual([])
  })
})

describe('what it saves', () => {
  /**
   * Markets roll at duration/2, so creations per day is 172800/duration. This
   * is the arithmetic the decision rests on, pinned so the claim in the commit
   * message stays checkable.
   */
  it('counts rollovers the way the keeper actually schedules them', () => {
    expect(creationsPerDay([300])).toBe(576)
    expect(creationsPerDay([900])).toBe(192)
    expect(creationsPerDay([86400])).toBe(2)
  })

  it('cuts 93% of market creation when idle', () => {
    const busy = creationsPerDay(ALL_DURATIONS_EXAMPLE)
    const idle = creationsPerDay(durationsToMaintain(ALL_DURATIONS_EXAMPLE, null, NOW, opts))

    expect(1 - idle / busy).toBeGreaterThan(0.92)
  })
})

describe('isUserPresent', () => {
  it('counts a request inside the window', () => {
    expect(isUserPresent(NOW - 5 * MIN, NOW, 15 * MIN)).toBe(true)
  })

  it('does not count one outside it, or none at all', () => {
    expect(isUserPresent(NOW - 16 * MIN, NOW, 15 * MIN)).toBe(false)
    expect(isUserPresent(null, NOW, 15 * MIN)).toBe(false)
  })
})
