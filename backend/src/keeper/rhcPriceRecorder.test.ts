import { describe, it, expect } from 'vitest'
import { fetchRhcPoolPrices } from './rhcPriceRecorder'

describe('fetchRhcPoolPrices (audit A07, 2026-09-28)', () => {
  it('reads every pool and returns its price', async () => {
    const feeds = [
      { feedId: '0xpool1', symbol: 'PEPE' },
      { feedId: '0xpool2', symbol: 'WIF' },
    ]
    const prices: Record<string, bigint> = { '0xpool1': 1_000_000_000_000_000_000n, '0xpool2': 42n }

    const result = await fetchRhcPoolPrices(feeds, async (feedId) => prices[feedId])

    expect(result).toEqual([
      { feedId: '0xpool1', symbol: 'PEPE', price: 1_000_000_000_000_000_000n },
      { feedId: '0xpool2', symbol: 'WIF', price: 42n },
    ])
  })

  it('skips a pool whose read reverts without losing the others', async () => {
    const feeds = [
      { feedId: '0xdead', symbol: 'DEADPOOL' },
      { feedId: '0xalive', symbol: 'ALIVE' },
    ]

    const result = await fetchRhcPoolPrices(feeds, async (feedId) => {
      if (feedId === '0xdead') throw new Error('pool has no liquidity')
      return 5n
    })

    expect(result).toEqual([{ feedId: '0xalive', symbol: 'ALIVE', price: 5n }])
  })

  it('returns nothing for an empty pool list rather than erroring', async () => {
    const result = await fetchRhcPoolPrices([], async () => {
      throw new Error('should never be called')
    })
    expect(result).toEqual([])
  })
})
