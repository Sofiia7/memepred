import { useRef, useEffect, useState } from 'react'

export type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d'
type ChartMode = 'price' | 'prob'

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
  candles?:      Candle[]
  probHistory?:  ProbPoint[]
  onTfChange?:   (tf: Timeframe) => void
}

const COL_UP = '#4d8dff'
const COL_DN = '#ff3d6e'
const COL_GRID = 'rgba(255,255,255,0.06)'
const COL_LABEL = 'rgba(255,255,255,0.4)'

export function MarketChart({ candles, probHistory, onTfChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [mode, setMode] = useState<ChartMode>('price')
  const [tf,   setTf]   = useState<Timeframe>('5m')

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
    if (mode === 'prob'  && probHistory?.length) drawProb(ctx, probHistory, W, H)
  }, [candles, probHistory, mode, tf])

  function drawCandles(ctx: CanvasRenderingContext2D, data: Candle[], W: number, H: number) {
    const pad = { t: 16, b: 24, l: 4, r: 56 }
    const prices = data.flatMap(c => [c.high, c.low])
    const minP = Math.min(...prices)
    const maxP = Math.max(...prices)
    const range = maxP - minP || 1
    const cw = (W - pad.l - pad.r) / data.length
    const toY = (p: number) => pad.t + (1 - (p - minP) / range) * (H - pad.t - pad.b)

    ctx.strokeStyle = COL_GRID
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (i / 4) * (H - pad.t - pad.b)
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke()
      const v = maxP - (i / 4) * range
      ctx.fillStyle = COL_LABEL
      ctx.font = '9px JetBrains Mono'
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

  function drawProb(ctx: CanvasRenderingContext2D, data: ProbPoint[], W: number, H: number) {
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
      ctx.font = '9px JetBrains Mono'
      ctx.fillText(`${v}%`, W - pad.r + 4, toY(v) + 3)
    })
  }

  const tfList: Timeframe[] = ['5m', '15m', '1h', '4h', '1d']

  return (
    <div style={{ background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--line)', overflow: 'hidden', marginBottom: 12, backdropFilter: 'var(--glass-blur)' }}>
      <div style={{ display: 'flex', borderBottom: '1px solid var(--line)' }}>
        {(['price', 'prob'] as ChartMode[]).map(m => (
          <button key={m} onClick={() => setMode(m)} style={{
            padding: '8px 14px', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
            color: mode === m ? '#fff' : 'var(--text-dim)',
            background: mode === m ? 'rgba(0,0,255,0.16)' : 'transparent',
            borderBottom: `2px solid ${mode === m ? 'var(--base-blue-2)' : 'transparent'}`,
            letterSpacing: '0.14em', textTransform: 'uppercase'
          }}>{m === 'price' ? 'PRICE' : 'PROB'}</button>
        ))}
      </div>
      <div style={{ height: 180, padding: 8 }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      </div>
      <div style={{ display: 'flex', gap: 4, padding: '4px 12px 8px' }}>
        {tfList.map(t => (
          <button key={t} onClick={() => { setTf(t); onTfChange?.(t) }} style={{
            padding: '4px 9px', borderRadius: 5, fontFamily: 'var(--mono)',
            fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
            color: tf === t ? '#fff' : 'var(--text-dim)',
            background: tf === t ? 'rgba(0,0,255,0.22)' : 'transparent',
            border: `1px solid ${tf === t ? 'var(--base-blue)' : 'var(--line)'}`,
          }}>{t.toUpperCase()}</button>
        ))}
      </div>
    </div>
  )
}
