import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Pools, marketForChip, marketIndex } from './Pools'
import { addressToFeedId } from '../lib/symbols'
import type { Market } from '../hooks/useMarkets'
import type { Pool } from '../hooks/usePools'

/**
 * A duration chip on a pool was a label. Someone who came to the Pools page to
 * trade a token had nowhere to click; the pools API returns only durations, so
 * the address of the market behind a chip has to be found in the markets list,
 * by the pool address padded to the 32 bytes a market stores as its feedId.
 */

const POOL = '0x52908400098527886e0f7030069857d2e4169ee7'
const OTHER_POOL = '0x1111111111111111111111111111111111111111'
const MARKET_5M = '0x00000000000000000000000000000000000000a5'
const MARKET_15M = '0x00000000000000000000000000000000000000f5'

const mkt = (over: Partial<Market>): Market => ({
  address: MARKET_5M, feedId: addressToFeedId(POOL), feedSymbol: 'PEPE', duration: 300, openTime: 1, closeTime: null,
  entryPrice: 1, exitPrice: null, status: 'OPEN', upWon: null, upPool: 0, downPool: 0, ...over,
})

const pool = (over: Partial<Pool> = {}): Pool => ({
  pool: POOL, token: '0x2222222222222222222222222222222222222222', symbol: 'PEPE', feeTier: 3000, status: 'ONBOARDED',
  reason: null, wethDepth: 12.5, cardinality: 100, ageSec: 3600, lastCheckedSec: 30, marketDurations: [300], ...over,
})

let poolsState: { data?: unknown; isError?: boolean; isLoading?: boolean; dataUpdatedAt?: number }
let openMarkets: Market[] | undefined

vi.mock('../hooks/usePools', () => ({
  usePools: () => ({
    data: poolsState.data, isError: !!poolsState.isError, isLoading: !!poolsState.isLoading,
    refetch: vi.fn(), dataUpdatedAt: poolsState.dataUpdatedAt ?? 0,
  }),
}))
vi.mock('../hooks/useMarkets', () => ({
  useMarkets: () => ({ data: openMarkets, isError: false, refetch: vi.fn(), dataUpdatedAt: Date.now() }),
}))
vi.mock('../components/ui/AppShell', () => ({
  ScreenTitle: ({ title, liveLabel, liveColor }: any) => (
    <h2 data-testid="title" data-label={liveLabel} data-color={liveColor}>{title}</h2>
  ),
  StatStrip: () => null,
}))

function renderPools() {
  return render(
    <MemoryRouter>
      <Pools />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  poolsState = { data: { chainId: 46630, poolBacked: true, pools: [pool()] }, dataUpdatedAt: Date.now() }
  openMarkets = [mkt({})]
})

afterEach(cleanup)

describe('marketForChip', () => {
  it('finds the market by the pool address padded to 32 bytes, and by duration', () => {
    const index = marketIndex([mkt({}), mkt({ address: MARKET_15M, duration: 900 })])
    expect(marketForChip(index, POOL, 300)?.address).toBe(MARKET_5M)
    expect(marketForChip(index, POOL, 900)?.address).toBe(MARKET_15M)
  })

  it('does not confuse two pools, or a duration that has no market', () => {
    const index = marketIndex([mkt({})])
    expect(marketForChip(index, OTHER_POOL, 300)).toBeUndefined()
    expect(marketForChip(index, POOL, 60)).toBeUndefined()
  })

  it('is case-insensitive on the pool address', () => {
    const index = marketIndex([mkt({})])
    expect(marketForChip(index, POOL.toUpperCase().replace('0X', '0x'), 300)?.address).toBe(MARKET_5M)
  })

  it('copes with no markets at all', () => {
    expect(marketForChip(marketIndex(undefined), POOL, 300)).toBeUndefined()
  })
})

describe('Pools: duration chips', () => {
  it('a chip is a link to its market, with a Trade call to action', () => {
    renderPools()

    const chip = screen.getByRole('link', { name: /trade pepe on the 5m market/i })
    expect(chip.getAttribute('href')).toBe(`/market/${MARKET_5M}`)
    expect(chip.textContent).toContain('5m')
    expect(chip.textContent).toContain('Trade')
  })

  it('links each duration to its own market', () => {
    poolsState = { data: { chainId: 46630, poolBacked: true, pools: [pool({ marketDurations: [300, 900] })] }, dataUpdatedAt: Date.now() }
    openMarkets = [mkt({}), mkt({ address: MARKET_15M, duration: 900 })]
    renderPools()

    // "on the 5m market" - a bare /5m market/ would also match "15m market".
    expect(screen.getByRole('link', { name: /on the 5m market/i }).getAttribute('href')).toBe(`/market/${MARKET_5M}`)
    expect(screen.getByRole('link', { name: /on the 15m market/i }).getAttribute('href')).toBe(`/market/${MARKET_15M}`)
  })

  it('stays a plain label while the markets list has not the address (yet)', () => {
    openMarkets = undefined
    renderPools()

    expect(screen.queryByRole('link', { name: /trade/i })).toBeNull()
    expect(screen.getByText('5m')).toBeDefined()
  })

  it('a pool with no market shows the reason, not chips', () => {
    poolsState = {
      data: { chainId: 46630, poolBacked: true, pools: [pool({ marketDurations: [], status: 'REJECTED', reason: 'not enough liquidity' })] },
      dataUpdatedAt: Date.now(),
    }
    renderPools()
    expect(screen.getByText('not enough liquidity')).toBeDefined()
    expect(screen.queryByRole('link', { name: /trade/i })).toBeNull()
  })
})

describe('Pools: the dot', () => {
  const dot = () => screen.getByTestId('title')

  it('says watching while the feed is fresh', () => {
    renderPools()
    expect(dot().getAttribute('data-label')).toBe('watching')
    expect(dot().getAttribute('data-color')).toBe('var(--up)')
  })

  it('says offline, in red, when the feed fails', () => {
    poolsState = { data: undefined, isError: true, dataUpdatedAt: 0 }
    renderPools()
    expect(dot().getAttribute('data-label')).toBe('offline')
    expect(dot().getAttribute('data-color')).toBe('var(--down)')
  })

  it('goes amber when the data has stopped updating', () => {
    poolsState = { data: { chainId: 46630, poolBacked: true, pools: [pool()] }, dataUpdatedAt: Date.now() - 10 * 60_000 }
    renderPools()
    expect(dot().getAttribute('data-color')).toBe('var(--warn)')
    expect(dot().getAttribute('data-label')).toMatch(/^stale/)
  })

  it('is grey while it is still loading', () => {
    poolsState = { data: undefined, isLoading: true, dataUpdatedAt: 0 }
    renderPools()
    expect(dot().getAttribute('data-label')).toBe('connecting')
    expect(dot().getAttribute('data-color')).toBe('var(--text-faint)')
  })
})
