import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useCandles, useProbHistory } from './useCandles'

/**
 * The market page renders before the markets list has said which feed it is, so
 * its feedId starts out empty. useCandles used to fire anyway and asked the API
 * for /api/candles/?tf=5m - a 404 on every page load, and a blank chart.
 */

const FEED = '0x' + '0'.repeat(24) + 'ab'.repeat(20)
const MARKET = '0x' + 'cd'.repeat(20)

let fetchMock: ReturnType<typeof vi.fn>

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function Candles({ feedId, tf }: { feedId: string; tf?: '5m' | '1h' }) {
  const q = useCandles(feedId, tf)
  return (
    <>
      <div data-testid="status">{q.fetchStatus}</div>
      <div data-testid="count">{q.data?.length ?? 'none'}</div>
      <div data-testid="error">{String(q.isError)}</div>
    </>
  )
}

function Prob({ market }: { market: string }) {
  const q = useProbHistory(market)
  return <div data-testid="status">{q.fetchStatus}</div>
}

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ time: 1, open: 1, high: 2, low: 1, close: 2 }] }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

describe('useCandles', () => {
  it('does not fetch while the feed is unknown (empty feedId)', async () => {
    wrap(<Candles feedId="" />)
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('status').textContent).toBe('idle')
  })

  it('does not fetch for something that is not a feed id either (the API would 400)', async () => {
    wrap(<Candles feedId="0x1234" />)
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches once the feed id is known, for the right feed and timeframe', async () => {
    wrap(<Candles feedId={FEED} tf="1h" />)
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/api/candles/${FEED}?tf=1h&limit=100`)
  })

  it('starts fetching when an empty feed id becomes real', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(
      <QueryClientProvider client={client}><Candles feedId="" /></QueryClientProvider>,
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchMock).not.toHaveBeenCalled()

    rerender(<QueryClientProvider client={client}><Candles feedId={FEED} /></QueryClientProvider>)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('reports a failed request as an error state (the chart shows Retry for it)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
    wrap(<Candles feedId={FEED} />)
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('true'))
  })
})

describe('useProbHistory', () => {
  it('does not fetch without a market address', async () => {
    wrap(<Prob market="" />)
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches for a real market address', async () => {
    wrap(<Prob market={MARKET} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/api/candles/${MARKET}/prob-history`)
  })
})
