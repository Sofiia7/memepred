import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MarketChart, chartBodyState, type Candle } from './MarketChart'

/**
 * The chart used to draw on a canvas and say nothing else: no feed yet, no
 * history, a failed request and a slow one all looked like the same blank box.
 * And a tab called PROB plotted the share of waiting stake as if it were the
 * chance that UP wins.
 */

const FEED = '0x' + '00'.repeat(32)
const candle = (i: number): Candle => ({ time: i, open: 1, high: 2, low: 0.5, close: 1.5 })

beforeAll(() => {
  // jsdom has no canvas; the chart's drawing effect just gives up on null.
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})

afterEach(cleanup)

describe('chartBodyState', () => {
  const base = { mode: 'price' as const, feedId: FEED }

  it('draws when there are candles', () => {
    expect(chartBodyState({ ...base, candles: [candle(1)] })).toEqual({ kind: 'chart' })
  })

  it('keeps the chart when a background refetch fails: data in hand wins', () => {
    expect(chartBodyState({ ...base, candles: [candle(1)], candlesError: true })).toEqual({ kind: 'chart' })
  })

  it('says "No price history yet" for a loaded, empty answer', () => {
    expect(chartBodyState({ ...base, candles: [] })).toEqual({ kind: 'empty', text: 'No price history yet' })
    expect(chartBodyState({ ...base })).toEqual({ kind: 'empty', text: 'No price history yet' })
  })

  it('says it is loading while the request is in flight, or while the feed is not known yet', () => {
    expect(chartBodyState({ ...base, candlesLoading: true }).kind).toBe('loading')
    // No feed id: nothing can be asked yet, and "no history" would be premature.
    expect(chartBodyState({ ...base, feedId: '' }).kind).toBe('loading')
  })

  it('reports an error, not an empty chart, when the request failed', () => {
    expect(chartBodyState({ ...base, candlesError: true })).toEqual({
      kind: 'error',
      text: "Couldn't load price history",
    })
  })

  it('the queue line needs two points', () => {
    const queue = { mode: 'queue' as const, feedId: FEED }
    expect(chartBodyState({ ...queue, probHistory: [{ ts: 1, upPct: 50 }] }).kind).toBe('empty')
    expect(chartBodyState({ ...queue, probHistory: [{ ts: 1, upPct: 50 }, { ts: 2, upPct: 60 }] }).kind).toBe('chart')
    expect(chartBodyState({ ...queue, probError: true }).kind).toBe('error')
    expect(chartBodyState({ ...queue, probLoading: true }).kind).toBe('loading')
  })
})

describe('MarketChart', () => {
  it('shows an explicit empty state instead of a blank canvas', () => {
    render(<MarketChart feedId={FEED} marketAddress="0xm" candles={[]} />)
    expect(screen.getByRole('status').textContent).toBe('No price history yet')
  })

  it('shows the error with a Retry that retries', () => {
    const onRetryCandles = vi.fn()
    render(<MarketChart feedId={FEED} marketAddress="0xm" candlesError onRetryCandles={onRetryCandles} />)

    expect(screen.getByRole('alert').textContent).toContain("Couldn't load price history")
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(onRetryCandles).toHaveBeenCalledTimes(1)
  })

  it('shows loading while it waits', () => {
    render(<MarketChart feedId={FEED} marketAddress="0xm" candlesLoading />)
    expect(screen.getByRole('status').textContent).toBe('Loading price history…')
  })

  it('has no overlay once there is something to draw', () => {
    render(<MarketChart feedId={FEED} marketAddress="0xm" candles={[candle(1), candle(2)]} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('names the chart for a screen reader', () => {
    render(<MarketChart feedId={FEED} marketAddress="0xm" symbol="PEPE" candles={[candle(1)]} />)
    expect(screen.getByRole('img', { name: 'Price chart for PEPE, 5m candles' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '1H' }))
    expect(screen.getByRole('img', { name: 'Price chart for PEPE, 1h candles' })).toBeDefined()
  })

  it('reports a timeframe change to the page', () => {
    const onTfChange = vi.fn()
    render(<MarketChart feedId={FEED} marketAddress="0xm" candles={[candle(1)]} onTfChange={onTfChange} />)
    fireEvent.click(screen.getByRole('button', { name: '4H' }))
    expect(onTfChange).toHaveBeenCalledWith('4h')
  })
})

describe('MarketChart: the queue tab is not a probability', () => {
  it('is called QUEUE, and there is no PROB tab', () => {
    render(<MarketChart feedId={FEED} marketAddress="0xm" candles={[candle(1)]} />)
    expect(screen.getByRole('button', { name: 'QUEUE' })).toBeDefined()
    expect(screen.queryByRole('button', { name: /prob/i })).toBeNull()
  })

  it('says on hover and on screen that it is not the chance UP wins', () => {
    render(<MarketChart feedId={FEED} marketAddress="0xm" candles={[candle(1)]} />)
    const tab = screen.getByRole('button', { name: 'QUEUE' })
    expect(tab.getAttribute('title')).toBe('Share of waiting orders, not the chance UP wins')

    expect(screen.queryByText(/not the chance that UP wins/)).toBeNull()
    fireEvent.click(tab)
    expect(screen.getByText(/Share of waiting orders on the UP side - not the chance that UP wins/)).toBeDefined()
  })

  it('has its own empty and error states', () => {
    const onRetryProb = vi.fn()
    const { rerender } = render(<MarketChart feedId={FEED} marketAddress="0xm" candles={[candle(1)]} probHistory={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'QUEUE' }))
    expect(screen.getByRole('status').textContent).toBe('No queue history yet')

    rerender(<MarketChart feedId={FEED} marketAddress="0xm" candles={[candle(1)]} probError onRetryProb={onRetryProb} />)
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(onRetryProb).toHaveBeenCalledTimes(1)
  })

  it('names the queue chart differently from the price chart', () => {
    render(<MarketChart feedId={FEED} marketAddress="0xm" symbol="PEPE" candles={[candle(1)]} />)
    fireEvent.click(screen.getByRole('button', { name: 'QUEUE' }))
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/Queue chart for PEPE: share of waiting stake on the UP side/)
  })
})
