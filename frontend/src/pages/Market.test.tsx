import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Market } from './Market'

/**
 * The market page: what it does with an address that is not one, what its dot
 * claims about the data, and what its chart says when there is nothing to draw.
 * The chart itself is the real component; the Composer, the shell and the data
 * hooks are stubbed so the page's own decisions are what is under test.
 */

const MARKET = '0x00000000000000000000000000000000000000aa'
const FEED = '0x' + '00'.repeat(12) + 'aa'.repeat(20)

const market = {
  address: MARKET, feedId: FEED, feedSymbol: 'PEPE', duration: 300, openTime: 1, closeTime: null,
  entryPrice: 1, exitPrice: null, status: 'OPEN', upWon: null, upPool: 0, downPool: 0,
}

let marketsState: { data?: unknown[]; isError?: boolean; dataUpdatedAt?: number }
let candlesState: { data?: unknown[]; isLoading?: boolean; isError?: boolean }
let priceStale: boolean
let isMarketRead: { data?: boolean; isLoading?: boolean; isError?: boolean }
let readCalls: any[]
const refetchCandles = vi.fn()
const refetchProb = vi.fn()
const useCandlesSpy = vi.fn()
const useProbSpy = vi.fn()

vi.mock('wagmi', () => ({
  useReadContract: (args: any) => {
    readCalls.push(args)
    return { data: isMarketRead.data, isLoading: !!isMarketRead.isLoading, isError: !!isMarketRead.isError, refetch: vi.fn() }
  },
}))
vi.mock('../components/ui/AppShell', () => ({
  ScreenTitle: ({ title, liveLabel, liveColor }: any) => (
    <h2 data-testid="title" data-label={liveLabel} data-color={liveColor}>{title}</h2>
  ),
  StatStrip: () => null,
}))
vi.mock('../components/ui/Composer', () => ({ Composer: () => <div data-testid="composer" /> }))
vi.mock('../hooks/useMarkets', () => ({
  useMarkets: () => ({
    data: marketsState.data, isError: !!marketsState.isError, refetch: vi.fn(),
    dataUpdatedAt: marketsState.dataUpdatedAt ?? 0,
  }),
}))
vi.mock('../hooks/useOdds', () => ({ useOdds: () => ({ upDepth: 1n, downDepth: 2n }) }))
vi.mock('../hooks/usePythPrice', () => ({
  usePythPrice: () => ({
    display: 1.5, raw: 1_500_000_000_000_000_000n, stale: priceStale, loading: false,
    status: priceStale ? 'stale' : 'live',
  }),
}))
vi.mock('../hooks/useCandles', () => ({
  useCandles: (feedId: string, tf: string) => {
    useCandlesSpy(feedId, tf)
    return { data: candlesState.data, isLoading: !!candlesState.isLoading, isError: !!candlesState.isError, refetch: refetchCandles }
  },
  useProbHistory: (address: string) => {
    useProbSpy(address)
    return { data: undefined, isLoading: false, isError: false, refetch: refetchProb }
  },
}))

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/market/:address" element={<Market />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  marketsState = { data: [market], dataUpdatedAt: Date.now() }
  candlesState = { data: [] }
  priceStale = false
  isMarketRead = { data: true }
  readCalls = []
  useCandlesSpy.mockClear()
  useProbSpy.mockClear()
  refetchCandles.mockClear()
})

afterEach(cleanup)

describe('Market page: a bad address', () => {
  it.each(['nope', '0x1234', '0x0000000000000000000000000000000000000000'])(
    '%s says "Invalid market link" instead of a verification error with a useless Retry',
    (bad) => {
      renderAt(`/market/${bad}`)

      expect(screen.getByText('Invalid market link')).toBeDefined()
      expect(screen.queryByText(/couldn't verify/i)).toBeNull()
      expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
      expect(screen.queryByTestId('composer')).toBeNull()
      expect(screen.getByRole('link', { name: /back to markets/i }).getAttribute('href')).toBe('/')
    },
  )

  it('never asks the chain, the candles API or the price feed about it', () => {
    renderAt('/market/nope')

    // Every isMarket() read is switched off, and the candle and queue queries
    // are handed nothing to fetch.
    expect(readCalls.length).toBeGreaterThan(0)
    expect(readCalls.every((c) => c.query?.enabled === false)).toBe(true)
    expect(useCandlesSpy).toHaveBeenCalledWith('', '5m')
    expect(useProbSpy).toHaveBeenCalledWith('')
  })

  it('a real address does enable the isMarket() check, on that address', () => {
    renderAt(`/market/${MARKET}`)
    const call = readCalls.find((c) => c.functionName === 'isMarket')
    expect(call.query.enabled).toBe(true)
    expect(call.args).toEqual([MARKET])
  })
})

describe('Market page: the dot next to the title', () => {
  const dot = () => screen.getByTestId('title')

  it('is live and says continuous market while the data is fresh', () => {
    renderAt(`/market/${MARKET}`)
    expect(dot().getAttribute('data-label')).toBe('continuous market')
    expect(dot().getAttribute('data-color')).toBe('var(--up)')
  })

  it('turns amber and says so when the price stops updating', () => {
    priceStale = true
    renderAt(`/market/${MARKET}`)
    expect(dot().getAttribute('data-label')).toBe('continuous market · price stale')
    expect(dot().getAttribute('data-color')).toBe('var(--warn)')
  })

  it('turns red and says offline when the markets feed is failing', () => {
    marketsState = { data: [market], isError: true, dataUpdatedAt: Date.now() - 120_000 }
    renderAt(`/market/${MARKET}`)
    expect(dot().getAttribute('data-label')).toBe('continuous market · offline - last update 2m ago')
    expect(dot().getAttribute('data-color')).toBe('var(--down)')
  })

  it('is grey while it is still connecting', () => {
    marketsState = { data: undefined, dataUpdatedAt: 0 }
    renderAt(`/market/${MARKET}`)
    expect(dot().getAttribute('data-color')).toBe('var(--text-faint)')
    expect(dot().getAttribute('data-label')).toMatch(/connecting/)
  })

  it('goes amber when the markets list has not refreshed for a while, though nothing errored', () => {
    marketsState = { data: [market], dataUpdatedAt: Date.now() - 5 * 60_000 }
    renderAt(`/market/${MARKET}`)
    expect(dot().getAttribute('data-color')).toBe('var(--warn)')
    expect(dot().getAttribute('data-label')).toMatch(/stale/)
  })
})

describe('Market page: the chart says what is going on', () => {
  it('passes the market\'s feed to the candle query once it is known', () => {
    renderAt(`/market/${MARKET}`)
    expect(useCandlesSpy).toHaveBeenCalledWith(FEED, '5m')
  })

  it('asks for candles with an empty feed while the markets list has not answered yet', () => {
    marketsState = { data: undefined }
    renderAt(`/market/${MARKET}`)
    expect(useCandlesSpy).toHaveBeenCalledWith('', '5m')
    // ...and the chart says it is loading, not "no history".
    expect(screen.getByRole('status').textContent).toBe('Loading price history…')
  })

  it('says "No price history yet" for an empty answer', () => {
    candlesState = { data: [] }
    renderAt(`/market/${MARKET}`)
    expect(screen.getByRole('status').textContent).toBe('No price history yet')
  })

  it('shows an error with Retry when the candles could not be loaded', () => {
    candlesState = { data: undefined, isError: true }
    renderAt(`/market/${MARKET}`)

    expect(screen.getByRole('alert').textContent).toContain("Couldn't load price history")
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(refetchCandles).toHaveBeenCalledTimes(1)
  })

  it('names the chart after the coin', () => {
    renderAt(`/market/${MARKET}`)
    expect(screen.getByRole('img', { name: 'Price chart for PEPE, 5m candles' })).toBeDefined()
  })
})

describe('Market page: the address check still gates trading (audit A05)', () => {
  it('shows the Composer only for a confirmed market', () => {
    renderAt(`/market/${MARKET}`)
    expect(screen.getByTestId('composer')).toBeDefined()
  })

  it('warns off an address the factory did not create', () => {
    isMarketRead = { data: false }
    renderAt(`/market/${MARKET}`)
    expect(screen.getByText(/not a real market/i)).toBeDefined()
    expect(screen.queryByTestId('composer')).toBeNull()
  })

  it('a failed check has its own Retry', () => {
    isMarketRead = { data: undefined, isError: true }
    renderAt(`/market/${MARKET}`)
    expect(screen.getByText(/couldn't verify this is a real market/i)).toBeDefined()
    expect(screen.queryByTestId('composer')).toBeNull()
  })
})
