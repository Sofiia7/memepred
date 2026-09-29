// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { statForMarket, symbolFromStats, type MarketStats } from './useMarketStats'

const POOL_A = '0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const POOL_B = '0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

/** Two pools whose tokens share the symbol PEPE - a look-alike is exactly this. */
const perFeed: MarketStats = {
  volume24h: 1,
  symbols: [
    { feedId: POOL_A, symbol: 'PEPE', price: 1.5, chg24h: 3 },
    { feedId: POOL_B, symbol: 'PEPE', price: 0.0001, chg24h: -40 },
  ],
}

describe('statForMarket', () => {
  it('looks up by feed first, so a look-alike does not get the real one\'s price', () => {
    expect(statForMarket(perFeed, POOL_A, 'PEPE')?.price).toBe(1.5)
    expect(statForMarket(perFeed, POOL_B, 'PEPE')?.price).toBe(0.0001)
    // The old symbol lookup answers with whichever PEPE comes first.
    expect(symbolFromStats(perFeed, 'PEPE')?.price).toBe(1.5)
  })

  it('matches a feed regardless of case', () => {
    expect(statForMarket(perFeed, POOL_B.toUpperCase().replace('0X', '0x'), 'PEPE')?.price).toBe(0.0001)
  })

  it('matches a feed regardless of how it is padded', () => {
    expect(statForMarket(perFeed, '0x' + 'aa'.repeat(20), 'PEPE')?.price).toBe(1.5)
  })

  it('a feed the backend does not list is "no price yet", not a same-symbol pool\'s price', () => {
    const POOL_C = '0x000000000000000000000000cccccccccccccccccccccccccccccccccccccccc'
    expect(statForMarket(perFeed, POOL_C, 'PEPE')).toBeUndefined()
  })

  it('falls back to the symbol for a backend that sends no feedIds at all', () => {
    const legacy: MarketStats = { volume24h: 0, symbols: [{ symbol: 'DOGE', price: 0.2, chg24h: 1 }] }
    expect(statForMarket(legacy, POOL_A, 'doge')?.price).toBe(0.2)
    expect(statForMarket(legacy, undefined, 'DOGE')?.price).toBe(0.2)
  })

  it('falls back to the symbol only among entries without a feed', () => {
    const mixed: MarketStats = {
      volume24h: 0,
      symbols: [
        { feedId: POOL_A, symbol: 'DOGE', price: 9, chg24h: 0 },
        { symbol: 'DOGE', price: 0.2, chg24h: 1 },
      ],
    }
    expect(statForMarket(mixed, POOL_B, 'DOGE')?.price).toBe(0.2)
  })

  it('on Base the symbol IS the feed: a row with an older oracle feedId still prices the market', () => {
    // The backend keys Base rows by symbol and reports whichever feed_id the
    // newest price row carried, which need not be the market's own.
    const base: MarketStats = {
      volume24h: 0,
      symbols: [{ feedId: '0x' + 'ee'.repeat(32), symbol: 'DOGE', price: 0.2, chg24h: 1 }],
    }
    const marketFeed = '0x' + '11'.repeat(32)
    expect(statForMarket(base, marketFeed, 'DOGE', 'any')?.price).toBe(0.2)
    // The pool-backed rule refuses the same row: it names another feed.
    expect(statForMarket(base, marketFeed, 'DOGE', 'unkeyed')).toBeUndefined()
    expect(statForMarket(base, marketFeed, 'DOGE')).toBeUndefined()
  })

  it('a feed match beats a symbol match under either rule', () => {
    expect(statForMarket(perFeed, POOL_B, 'PEPE', 'any')?.price).toBe(0.0001)
  })

  it('is undefined without stats or without anything to look up', () => {
    expect(statForMarket(undefined, POOL_A, 'PEPE')).toBeUndefined()
    expect(statForMarket(perFeed, undefined, undefined)).toBeUndefined()
  })
})
