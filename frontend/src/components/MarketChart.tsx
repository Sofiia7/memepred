import { useRef, useEffect, useState } from 'react'
import '../order.css'

export type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d'
type ChartMode = 'price' | 'queue'

export interface Candle {
  time:  number
  open:  number
  high:  number
  low:   number
  close: number
}
export interface ProbPoint {
  ts:     number
  upPct:  number
}

interface Props {
  feedId:        string
  marketAddress: string
  /** For the chart's accessible name. */
  symbol?:       string
  candles?:      Candle[]
  probHistory?:  ProbPoint[]
  candlesLoading?: boolean
  candlesError?:   boolean
  onRetryCandles?: () => void
  probLoading?:    boolean
  probError?:      boolean
  onRetryProb?:    () => void
  onTfChange?:   (tf: Timeframe) => void
}

const COL_UP = '#4d8dff'
const COL_DN = '#ff3d6e'
const COL_GRID = 'rgba(255,255,255,0.06)'
const COL_LABEL = 'rgba(255,255,255,0.4)'

/** What the chart area shows instead of a bare, blank canvas. */
export type ChartBodyState =
  | { kind: 'chart' }
  | { kind: 'loading'; text: string }
  | { kind: 'empty'; text: string }
  | { kind: 'error'; text: string }

/**
 * Decide the chart area's state. Pure so the four cases are testable without a
 * canvas. Data that is already here always wins: a failed background refetch
 * must not blank a chart that was drawn a minute ago.
 */
export function chartBodyState(input: {
  mode: ChartMode
  feedId: string
  candles?: Candle[]
  probHistory?: ProbPoint[]
  candlesLoading?: boolean
  candlesError?: boolean
  probLoading?: boolean
  probError?: boolean
}): ChartBodyState {
  if (input.mode === 'price') {
    if (input.candles && input.candles.length > 0) return { kind: 'chart' }
    if (input.candlesError) return { kind: 'error', text: "Couldn't load price history" }
    // Before the markets list has said which feed this is, nothing can be asked.
    if (!input.feedId || input.candlesLoading) return { kind: 'loading', text: 'Loading price history…' }
    return { kind: 'empty', text: 'No price history yet' }
  }
  // A line needs two points.
  if (input.probHistory && input.probHistory.length >= 2) return { kind: 'chart' }
  if (input.probError) return { kind: 'error', text: "Couldn't load queue history" }
  if (input.probLoading) return { kind: 'loading', text: 'Loading queue history…' }
  return { kind: 'empty', text: 'No queue history yet' }
}

export function MarketChart({
  symbol, feedId, candles, probHistory,
  candlesLoading, candlesError, onRetryCandles,
  probLoading, probError, onRetryProb,
  onTfChange,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [mode, setMode] = useState<ChartMode>('price')
  const [tf,   setTf]   = useState<Timeframe>('5m')

  const body = chartBodyState({
    mode, feedId, candles, probHistory, candlesLoading, candlesError, probLoading, probError,
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = canvas.offsetWidth
    const H = canvas.offsetHeight
    canvas.width  = W * window.devicePixelRatio
    canvas.height = H * window.devicePixelRatio
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
    ctx.clearRect(0, 0, W, H)

    if (mode === 'price' && candles?.length)     drawCandles(ctx, candles, W, H)
    if (mode === 'queue' && probHistory?.length) drawQueue(ctx, probHistory, W, H)
  }, [candles, probHistory, mode, tf])

  function drawCandles(ctx: CanvasRenderingContext2D, data: Candle[], W: number, H: number) {
    const pad = { t: 16, b: 24, l: 4, r: 56 }
    const prices = data.flatMap(c => [c.high, c.low])
    let minP = Math.min(...prices)
    let maxP = Math.max(...prices)
    // A flat or nearly flat series (a pool nobody has traded through, or one
    // moved by less than a fifth of a percent) used to fall back to a range of 1,
    // which drew the line along the bottom of an axis running from 0.02 to 1.02.
    // Widen it to about 0.4% around the price so the line sits in the middle.
    const mid = (minP + maxP) / 2
    if (maxP - minP < Math.abs(mid) * 0.002) {
      const half = Math.abs(mid) * 0.002 || 0.5
      minP = mid - half
      maxP = mid + half
    }
    const range = maxP - minP
    const cw = (W - pad.l - pad.r) / data.length
    const toY = (p: number) => pad.t + (1 - (p - minP) / range) * (H - pad.t - pad.b)

    ctx.strokeStyle = COL_GRID
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (i / 4) * (H - pad.t - pad.b)
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke()
      const v = maxP - (i / 4) * range
      ctx.fillStyle = COL_LABEL
      ctx.font = '10px JetBrains Mono'
      ctx.fillText(v < 0.0001 ? v.toExponential(2) : v.toPrecision(4), W - pad.r + 4, y + 3)
    }

    data.forEach((c, i) => {
      const x = pad.l + i * cw + cw / 2
      const bw = Math.max(cw * 0.65, 2)
      const bull = c.close >= c.open
      const col = bull ? COL_UP : COL_DN
      ctx.strokeStyle = col
      ctx.beginPath(); ctx.moveTo(x, toY(c.high)); ctx.lineTo(x, toY(c.low)); ctx.stroke()
      const y1 = toY(Math.max(c.open, c.close))
      const y2 = toY(Math.min(c.open, c.close))
      ctx.fillStyle = bull ? 'rgba(77,141,255,0.85)' : 'rgba(255,61,110,0.85)'
      ctx.fillRect(x - bw / 2, y1, bw, Math.max(y2 - y1, 1))
    })
  }

  function drawQueue(ctx: CanvasRenderingContext2D, data: ProbPoint[], W: number, H: number) {
    const pad = { t: 16, b: 24, l: 4, r: 40 }
    const n = data.length
    if (n < 2) return
    const toX = (i: number) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r)
    const toY = (v: number) => pad.t + (1 - v / 100) * (H - pad.t - pad.b)

    ctx.strokeStyle = COL_GRID
    ctx.setLineDash([4, 4])
    const y50 = toY(50)
    ctx.beginPath(); ctx.moveTo(pad.l, y50); ctx.lineTo(W - pad.r, y50); ctx.stroke()
    ctx.setLineDash([])

    ctx.beginPath()
    data.forEach((d, i) => i === 0 ? ctx.moveTo(toX(i), toY(d.upPct)) : ctx.lineTo(toX(i), toY(d.upPct)))
    ctx.strokeStyle = COL_UP
    ctx.lineWidth = 2
    ctx.stroke()

    ;[0, 50, 100].forEach(v => {
      ctx.fillStyle = COL_LABEL
      ctx.font = '10px JetBrains Mono'
      ctx.fillText(`${v}%`, W - pad.r + 4, toY(v) + 3)
    })
  }

  const tfList: Timeframe[] = ['5m', '15m', '1h', '4h', '1d']

  const chartName =
    mode === 'price'
      ? `Price chart${symbol ? ` for ${symbol}` : ''}, ${tf} candles`
      : `Queue chart${symbol ? ` for ${symbol}` : ''}: share of waiting stake on the UP side over time`

  const retry = mode === 'price' ? onRetryCandles : onRetryProb

  return (
    <div style={{ background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--line)', overflow: 'hidden', marginBottom: 12, backdropFilter: 'var(--glass-blur)' }}>
      <div style={{ display: 'flex', borderBottom: '1px solid var(--line)' }}>
        {(['price', 'queue'] as ChartMode[]).map(m => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            // PROB used to sit here. The line is the share of stake WAITING on
            // the UP side; payouts are fixed, so it says nothing about who is
            // likely to win, and a tab called "probability" said that it did.
            title={m === 'queue' ? 'Share of waiting orders, not the chance UP wins' : undefined}
            onClick={() => setMode(m)}
            style={{
              padding: '11px 14px', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
              color: mode === m ? '#fff' : 'var(--text-dim)',
              background: mode === m ? 'rgba(0,0,255,0.16)' : 'transparent',
              borderBottom: `2px solid ${mode === m ? 'var(--base-blue-2)' : 'transparent'}`,
              letterSpacing: '0.14em', textTransform: 'uppercase'
            }}
          >{m === 'price' ? 'PRICE' : 'QUEUE'}</button>
        ))}
      </div>
      {mode === 'queue' && (
        <div className="chart-note">Share of waiting orders on the UP side - not the chance that UP wins.</div>
      )}
      <div className="chart-area">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={chartName}
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
        {body.kind !== 'chart' && (
          <div className={`chart-state chart-state-${body.kind}`} role={body.kind === 'error' ? 'alert' : 'status'}>
            <div>{body.text}</div>
            {body.kind === 'error' && retry && (
              <button type="button" className="chart-retry" onClick={() => retry()}>RETRY</button>
            )}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4, padding: '4px 12px 8px' }}>
        {tfList.map(t => (
          <button
            key={t}
            type="button"
            aria-pressed={tf === t}
            onClick={() => { setTf(t); onTfChange?.(t) }}
            style={{
              padding: '8px 11px', borderRadius: 5, fontFamily: 'var(--mono)',
              fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
              color: tf === t ? '#fff' : 'var(--text-dim)',
              background: tf === t ? 'rgba(0,0,255,0.22)' : 'transparent',
              border: `1px solid ${tf === t ? 'var(--base-blue)' : 'var(--line)'}`,
            }}
          >{t.toUpperCase()}</button>
        ))}
      </div>
    </div>
  )
}
