import { describe, it, expect } from 'vitest'
import { poolTotals, type PoolOrderRow } from './poolTotals.js'

const MKT = '0xaaa'

/** A fully staked, unrefunded 10 USDC UP order. */
const row = (over: Partial<PoolOrderRow> = {}): PoolOrderRow => ({
  marketAddress:     MKT,
  direction:         'UP',
  amountUsdc:        10,
  filledAmount:      10,
  status:            'MATCHED',
  unmatchedRefunded: false,
  ...over,
})

describe('poolTotals', () => {
  it('splits staked money by direction', () => {
    const t = poolTotals([
      row({ direction: 'UP',   amountUsdc: 10 }),
      row({ direction: 'DOWN', amountUsdc: 4  }),
      row({ direction: 'DOWN', amountUsdc: 1  }),
    ])
    expect(t.get(MKT)).toEqual({ up: 10, down: 5 })
  })

  it('keeps markets separate', () => {
    const t = poolTotals([
      row({ marketAddress: '0xaaa', amountUsdc: 3 }),
      row({ marketAddress: '0xbbb', amountUsdc: 7 }),
    ])
    expect(t.get('0xaaa')).toEqual({ up: 3, down: 0 })
    expect(t.get('0xbbb')).toEqual({ up: 7, down: 0 })
  })

  /**
   * A refunded order's money went back to the trader. Counting it would inflate
   * the pool for as long as the market row lives, and the odds history drawn
   * from it would claim depth that no longer exists.
   */
  it('excludes a fully refunded order', () => {
    const t = poolTotals([
      row({ amountUsdc: 10, status: 'REFUNDED' }),
      row({ amountUsdc: 2 }),
    ])
    expect(t.get(MKT)).toEqual({ up: 2, down: 0 })
  })

  /**
   * The partial-fill case. `refundExpired` returns only the unmatched tail and
   * sets `unmatched_refunded`, leaving the order MATCHED/SETTLED - so status
   * alone cannot tell you how much money is still committed. Only the filled
   * part is.
   */
  it('counts only the filled part once the unmatched tail was refunded', () => {
    const t = poolTotals([
      row({ amountUsdc: 10, filledAmount: 3, unmatchedRefunded: true }),
    ])
    expect(t.get(MKT)).toEqual({ up: 3, down: 0 })
  })

  it('counts the whole deposit while the tail is still outstanding', () => {
    const t = poolTotals([
      row({ amountUsdc: 10, filledAmount: 3, unmatchedRefunded: false }),
    ])
    expect(t.get(MKT)).toEqual({ up: 10, down: 0 })
  })

  it('counts money that is staked but not yet matched', () => {
    const t = poolTotals([
      row({ amountUsdc: 6, filledAmount: 0, status: 'PENDING' }),
    ])
    expect(t.get(MKT)).toEqual({ up: 6, down: 0 })
  })

  /**
   * A settled or claimed order was real money on that side while the market
   * ran. Dropping it at settlement would make the odds history of every
   * finished market collapse to 50/50 the moment it resolved.
   */
  it.each(['SETTLED', 'CLAIMED'])('still counts a %s order', (status) => {
    const t = poolTotals([row({ amountUsdc: 8, status })])
    expect(t.get(MKT)).toEqual({ up: 8, down: 0 })
  })

  it('returns an empty map for no orders', () => {
    expect(poolTotals([]).size).toBe(0)
  })
})
