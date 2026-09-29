// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { addressToFeedId, feedIdToAddress, isContinuousMarket } from './symbols'

const POOL = '0x52908400098527886E0F7030069857D2E4169EE7'

describe('addressToFeedId', () => {
  it('left-pads the pool address to 32 bytes, lowercase, like PoolMarketFactory.feedIdFor', () => {
    expect(addressToFeedId(POOL)).toBe('0x000000000000000000000000' + POOL.slice(2).toLowerCase())
    expect(addressToFeedId(POOL)).toHaveLength(66)
  })

  it('is the inverse of feedIdToAddress', () => {
    expect(feedIdToAddress(addressToFeedId(POOL))).toBe(POOL.toLowerCase())
  })

  it('agrees with the SQL the pools API joins on (0x || lpad(substr(pool, 3), 64, 0))', () => {
    const sql = (pool: string) => '0x' + pool.slice(2).padStart(64, '0')
    const lowerPool = POOL.toLowerCase()
    expect(addressToFeedId(lowerPool)).toBe(sql(lowerPool))
  })

  it('accepts an address without the 0x prefix', () => {
    expect(addressToFeedId(POOL.slice(2))).toBe(addressToFeedId(POOL))
  })
})

describe('isContinuousMarket', () => {
  it('a market with no close time has no round to count down to', () => {
    expect(isContinuousMarket(null)).toBe(true)
    expect(isContinuousMarket(undefined)).toBe(true)
    // Older API builds served the epoch for "none".
    expect(isContinuousMarket(0)).toBe(true)
  })

  it('a market with a close time is a countdown', () => {
    expect(isContinuousMarket(1_800_000_000)).toBe(false)
  })
})
