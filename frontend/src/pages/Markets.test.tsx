import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Markets } from './Markets'
import { addressToFeedId } from '../lib/symbols'
import type { Market } from '../hooks/useMarkets'
import type { MarketStats } from '../hooks/useMarketStats'

/**
 * The board: which price each card gets, and what the dot next to the title
 * claims. Prices were looked up by symbol, so two pools sharing a token symbol
 * (a look-alike token is exactly that) shared one price and one 24h change; the
 * dot said live whatever the API was doing.
 */

const POOL_A = '0x1111111111111111111111111111111111111111'
const POOL_B = '0x2222222222222222222222222222222222222222'
const FEED_A = addressToFeedId(POOL_A)
const FEED_B = addressToFeedId(POOL_B)

const mkt = (feedId: string, address: string, entryPrice: number | null): Market => ({
  address, feedId, feedSymbol: 'PEPE', duration: 300, openTime: 1, closeTime: null,
  entryPrice, exitPrice: null, status: 'OPEN', upWon: null, upPool: 0, downPool: 0,
})

let marketsState: { data?: Market[]; isLoading?: boolean; isError?: boolean; dataUpdatedAt?: number }
let statsState: MarketStats | undefined

vi.mock('../lib/chain', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/chain')>()
  return {
    ...real,
    IS_POOL_BACKED: true,
    CURRENCY: { decimals: 18, symbol: 'WETH', minBet: '0.005', maxBet: '0.04', displayDecimals: 4 },
  }
})
vi.mock('../hooks/useMarkets', () => ({
  useMarkets: () => ({
    data: marketsState.data, isLoading: !!marketsState.isLoading, isError: !!marketsState.isError,
    refetch: vi.fn(), dataUpdatedAt: marketsState.dataUpdatedAt ?? 0,
  }),
}))
// The real lookup (statForMarket) with a stubbed query.
vi.mock('../hooks/useMarketStats', async (importOriginal) => {
  const real = await importOriginal<typeof import('../hooks/useMarketStats')>()
  return { ...real, useMarketStats: () => ({ data: statsState }) }
})
vi.mock('../components/ui/AppShell', () => ({
  ScreenTitle: ({ title, liveLabel, liveColor }: any) => (
    <h2 data-testid="title" data-label={liveLabel} data-color={liveColor}>{title}</h2>
  ),
  StatStrip: () => null,
}))
vi.mock('../components/ui/Composer', () => ({ Composer: () => null }))
vi.mock('../components/ui/MarketCard', () => ({
  MarketCardUI: (p: any) => (
    <div data-testid="card" data-feed={p.feedId} data-price={String(p.livePrice)} data-chg={String(p.chg24h)} />
  ),
}))

const cards = () => screen.getAllByTestId('card').map((c) => ({
  feed: c.getAttribute('data-feed'), price: c.getAttribute('data-price'), chg: c.getAttribute('data-chg'),
}))

beforeEach(() => {
  marketsState = {
    data: [mkt(FEED_A, '0x00000000000000000000000000000000000000a1', 0.9), mkt(FEED_B, '0x00000000000000000000000000000000000000b1', 0.0002)],
    dataUpdatedAt: Date.now(),
  }
  statsState = undefined
})

afterEach(cleanup)

describe('Markets: a price for each pool (audit follow-up: stats by feed)', () => {
  it('gives two pools that share a symbol their own price and 24h change', () => {
    statsState = {
      volume24h: 0,
      symbols: [
        { feedId: FEED_A, symbol: 'PEPE', price: 1.5, chg24h: 3 },
        { feedId: FEED_B, symbol: 'PEPE', price: 0.0001, chg24h: -40 },
      ],
    }
    render(<Markets />)

    expect(cards()).toEqual([
      { feed: FEED_A, price: '1.5', chg: '3' },
      { feed: FEED_B, price: '0.0001', chg: '-40' },
    ])
  })

  it('a pool the backend has no price for keeps its own entry price, not a look-alike\'s', () => {
    statsState = {
      volume24h: 0,
      symbols: [{ feedId: FEED_A, symbol: 'PEPE', price: 1.5, chg24h: 3 }],
    }
    render(<Markets />)

    expect(cards()[1]).toEqual({ feed: FEED_B, price: '0.0002', chg: '0' })
  })

  it('falls back to the symbol while the backend still sends one row per symbol', () => {
    marketsState.data = [mkt(FEED_A, '0x00000000000000000000000000000000000000a1', 0.9)]
    statsState = { volume24h: 0, symbols: [{ symbol: 'PEPE', price: 1.25, chg24h: 7 }] }
    render(<Markets />)

    expect(cards()).toEqual([{ feed: FEED_A, price: '1.25', chg: '7' }])
  })
})

describe('Markets: the dot next to the title', () => {
  const dot = () => screen.getByTestId('title')

  it('is live while the board is refreshing', () => {
    render(<Markets />)
    expect(dot().getAttribute('data-label')).toBe('live')
    expect(dot().getAttribute('data-color')).toBe('var(--up)')
  })

  it('is grey and says connecting before the first answer', () => {
    marketsState = { data: undefined, isLoading: true, dataUpdatedAt: 0 }
    render(<Markets />)
    expect(dot().getAttribute('data-label')).toBe('connecting')
    expect(dot().getAttribute('data-color')).toBe('var(--text-faint)')
  })

  it('turns red and says offline when the markets feed fails', () => {
    marketsState = { data: undefined, isError: true, dataUpdatedAt: 0 }
    render(<Markets />)
    expect(dot().getAttribute('data-label')).toBe('offline')
    expect(dot().getAttribute('data-color')).toBe('var(--down)')
  })

  it('names how old the board is when it fails after having loaded', () => {
    marketsState.isError = true
    marketsState.dataUpdatedAt = Date.now() - 3 * 60_000
    render(<Markets />)
    expect(dot().getAttribute('data-label')).toBe('offline - last update 3m ago')
    expect(dot().getAttribute('data-color')).toBe('var(--down)')
  })

  it('turns amber when the board has stopped refreshing though nothing errored', () => {
    marketsState.dataUpdatedAt = Date.now() - 5 * 60_000
    render(<Markets />)
    expect(dot().getAttribute('data-color')).toBe('var(--warn)')
    expect(dot().getAttribute('data-label')).toBe('stale - 5m old')
  })
})
