import { describe, it, expect } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { AttemptTracker, notParkedSql } from './attemptTracker'

function make(maxAttempts = 3, cooldownMs = 60_000) {
  let t = 0
  const tracker = new AttemptTracker({ maxAttempts, cooldownMs, now: () => t })
  return { tracker, advance: (ms: number) => { t += ms } }
}

describe('AttemptTracker', () => {
  it('parks a key only after maxAttempts attempts in a row without progress', () => {
    const { tracker } = make(3)
    const key = AttemptTracker.keyOf('0xAbC', 7n)
    expect(tracker.fail(key)).toBe(false)
    expect(tracker.fail(key)).toBe(false)
    expect(tracker.isParked(key)).toBe(false)
    expect(tracker.fail(key)).toBe(true)
    expect(tracker.isParked(key)).toBe(true)
    expect(tracker.parkedKeys()).toEqual(['0xabc:7'])
  })

  it('forgets a key that made progress', () => {
    const { tracker } = make(3)
    tracker.fail('k')
    tracker.fail('k')
    tracker.clear('k')
    expect(tracker.fail('k')).toBe(false) // the count started over
    expect(tracker.isParked('k')).toBe(false)
  })

  it('releases a parked key after the cooldown for exactly one more attempt', () => {
    const { tracker, advance } = make(3, 60_000)
    for (let i = 0; i < 3; i++) tracker.fail('k')
    advance(59_999)
    expect(tracker.isParked('k')).toBe(true)

    advance(1)
    expect(tracker.isParked('k')).toBe(false)
    expect(tracker.parkedKeys()).toEqual([])
    // One failure is enough to park it again, not another full round.
    expect(tracker.fail('k')).toBe(true)
    expect(tracker.isParked('k')).toBe(true)
  })

  it('does not let unrelated keys interfere', () => {
    const { tracker } = make(2)
    tracker.fail('a')
    tracker.fail('b')
    expect(tracker.fail('a')).toBe(true)
    expect(tracker.isParked('b')).toBe(false)
  })
})

/**
 * The property the tracker exists for, against the real query shape: a stuck
 * row must stop occupying one of the N oldest slots.
 */
describe('notParkedSql', () => {
  it('lets a newer row into the window once the oldest one is parked', async () => {
    const db = new PGlite()
    await db.exec(`
      CREATE TABLE matches (market_address TEXT, match_id BIGINT, settled BOOLEAN, settle_at TIMESTAMPTZ);
      INSERT INTO matches VALUES
        ('0xm', 1, FALSE, NOW() - INTERVAL '3 days'),   -- stuck, oldest
        ('0xm', 2, FALSE, NOW() - INTERVAL '2 days'),
        ('0xm', 3, FALSE, NOW() - INTERVAL '1 day');
    `)
    const sql = (n: number) => `SELECT match_id FROM matches WHERE settled = FALSE AND ${notParkedSql('$1')} ORDER BY settle_at ASC LIMIT ${n}`

    const before = await db.query<any>(sql(1), [[]])
    expect(before.rows.map((r) => Number(r.match_id))).toEqual([1])

    const { tracker } = make(1)
    tracker.fail(AttemptTracker.keyOf('0xm', 1))
    const after = await db.query<any>(sql(1), [tracker.parkedKeys()])
    expect(after.rows.map((r) => Number(r.match_id))).toEqual([2])
  }, 120_000)
})
