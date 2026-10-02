import { useMemo, useState } from 'react'
import type { Address } from 'viem'
import { countdownFrom } from '../hooks/useNow'
import { clockTime, type RoundTimes } from './roundMath'
import { OUTCOME_REFUND, OUTCOME_TIE } from './roundsClient'
import { fmtPct, pctFromTicks, referenceOf, vsReference, yRange, type TickSample } from './strikeMath'
import { usePoolTicks } from './usePoolTicks'

export interface StrikeChartProps {
  pool: Address
  wethIsToken0: boolean
  symbol: string
  times: RoundTimes
  now: number
  strikeFixed: boolean
  entryTick: number
  exitTick: number
  outcome: number
  mySide: 'UP' | 'DOWN' | '?'
}

const W = 600
const H = 150
const PAD = { l: 44, r: 12, t: 10, b: 22 }

/**
 * The coin's price against the strike while a bet runs: the line the pool
 * reports every few seconds, the strike as the zero line once it exists, the
 * strike and exit windows marked on the time axis, and a headline that says
 * where the price is now against what decides the bet.
 */
export function StrikeChart(p: StrikeChartProps) {
  const samples = usePoolTicks(p.pool, p.wethIsToken0, p.now)
  const ref = referenceOf({ times: p.times, now: p.now, strikeFixed: p.strikeFixed, entryTick: p.entryTick, exitTick: p.exitTick, outcome: p.outcome, samples })
  const latest = samples[samples.length - 1]
  const nowPct = vsReference(latest, ref)
  const [hover, setHover] = useState<number | null>(null)

  // The drawing baseline: the strike when there is one, else the first sample, so the line still has a shape.
  const baseTick = ref.kind === 'pending' ? samples[0]?.tick ?? 0 : ref.tick
  const pts = useMemo(() => samples.map((s) => ({ t: s.t, pct: pctFromTicks(s.tick, baseTick) })), [samples, baseTick])
  const x0 = Math.min(p.times.openAt, samples[0]?.t ?? p.times.openAt)
  const x1 = Math.max(p.times.settleAt, p.now)
  const range = yRange(pts.map((q) => q.pct).concat(ref.kind === 'settled' ? [pctFromTicks(ref.exit, ref.tick)] : []))
  const X = (t: number) => PAD.l + ((t - x0) / Math.max(1, x1 - x0)) * (W - PAD.l - PAD.r)
  const Y = (pct: number) => PAD.t + ((range - pct) / (2 * range)) * (H - PAD.t - PAD.b)
  const path = pts.map((q, i) => `${i ? 'L' : 'M'}${X(q.t).toFixed(1)},${Y(q.pct).toFixed(1)}`).join(' ')
  const tone = nowPct === null ? '' : nowPct > 0 ? 'up' : nowPct < 0 ? 'down' : ''
  const hovered = hover === null ? undefined : nearest(pts, hover)

  const phase =
    ref.kind === 'settled'
      ? `Exit ${fmtPct(pctFromTicks(ref.exit, ref.tick))} vs strike: ${p.outcome === OUTCOME_TIE ? 'a tie' : p.outcome === OUTCOME_REFUND ? 'refunded' : p.outcome === 1 ? 'UP won' : 'DOWN won'}.`
      : p.now < p.times.closeAt
        ? `The price now does not count. The strike is averaged ${clockTime(p.times.strikeStart)}-${clockTime(p.times.strikeEnd)}.`
        : p.now < p.times.strikeStart
          ? `Pause. The strike is averaged from ${clockTime(p.times.strikeStart)} (in ${countdownFrom(p.times.strikeStart, p.now)}).`
          : p.now < p.times.strikeEnd
            ? `Strike being averaged until ${clockTime(p.times.strikeEnd)} (${countdownFrom(p.times.strikeEnd, p.now)} left). The line shows the price against the average so far.`
            : p.strikeFixed
              ? `Strike set. The exit is read at ${clockTime(p.times.settleAt)} (in ${countdownFrom(p.times.settleAt, p.now)}): ${p.mySide === 'UP' ? 'above' : 'below'} the strike then means you win.`
              : 'Strike window over; waiting for the keeper to fix the strike.'

  return (
    <div className="rnd-chart" aria-label={`${p.symbol} price against the strike`}>
      <div className="rnd-chart-head">
        <span className="rnd-chart-title">{p.symbol} vs strike</span>
        {nowPct !== null && ref.kind !== 'settled' && (
          <span className={'rnd-chart-now ' + tone}>
            now {fmtPct(nowPct)} {ref.kind === 'averaging' ? 'vs average so far' : 'vs strike'}
          </span>
        )}
        {ref.kind === 'pending' && latest && <span className="rnd-chart-now">no strike yet</span>}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="rnd-chart-svg"
        role="img"
        aria-label={nowPct === null ? 'price line' : `price now ${fmtPct(nowPct)} against the strike`}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const t = x0 + ((e.clientX - r.left) / r.width) * W
          setHover(x0 + ((t - x0 - PAD.l) / (W - PAD.l - PAD.r)) * (x1 - x0))
        }}
        onPointerLeave={() => setHover(null)}
      >
        {/* y labels: the range above and below the strike */}
        <text x={PAD.l - 6} y={PAD.t + 4} className="rnd-chart-tick" textAnchor="end">+{range.toFixed(2)}%</text>
        <text x={PAD.l - 6} y={Y(0) + 4} className="rnd-chart-tick" textAnchor="end">{ref.kind === 'pending' ? 'start' : 'strike'}</text>
        <text x={PAD.l - 6} y={H - PAD.b} className="rnd-chart-tick" textAnchor="end">-{range.toFixed(2)}%</text>
        {/* the strike (or the start) as the zero line */}
        <line x1={PAD.l} x2={W - PAD.r} y1={Y(0)} y2={Y(0)} className={'rnd-chart-zero' + (ref.kind === 'pending' ? ' faint' : '')} />
        {/* phases on the time axis */}
        {[
          { t: p.times.closeAt, l: 'close' },
          { t: p.times.strikeStart, l: 'strike' },
          { t: p.times.strikeEnd, l: '' },
          { t: p.times.settleAt, l: 'exit' },
        ].map((m) => (
          <g key={m.t}>
            <line x1={X(m.t)} x2={X(m.t)} y1={PAD.t} y2={H - PAD.b} className="rnd-chart-phase" />
            {m.l && <text x={X(m.t) + 3} y={H - 8} className="rnd-chart-tick">{m.l} {clockTime(m.t)}</text>}
          </g>
        ))}
        <rect x={X(p.times.strikeStart)} y={PAD.t} width={Math.max(1, X(p.times.strikeEnd) - X(p.times.strikeStart))} height={H - PAD.t - PAD.b} className="rnd-chart-window" />
        {/* the line and its last point */}
        {pts.length > 1 && <path d={path} className="rnd-chart-line" />}
        {latest && pts.length > 0 && <circle cx={X(latest.t)} cy={Y(pts[pts.length - 1].pct)} r="4" className={'rnd-chart-dot ' + tone} />}
        {ref.kind === 'settled' && (
          <circle cx={X(p.times.settleAt)} cy={Y(pctFromTicks(ref.exit, ref.tick))} r="5" className={'rnd-chart-dot ' + (pctFromTicks(ref.exit, ref.tick) > 0 ? 'up' : pctFromTicks(ref.exit, ref.tick) < 0 ? 'down' : '')} />
        )}
        {/* now */}
        <line x1={X(p.now)} x2={X(p.now)} y1={PAD.t} y2={H - PAD.b} className="rnd-chart-nowline" />
        {hovered && (
          <g>
            <line x1={X(hovered.t)} x2={X(hovered.t)} y1={PAD.t} y2={H - PAD.b} className="rnd-chart-cross" />
            <text x={Math.min(X(hovered.t) + 6, W - 120)} y={PAD.t + 14} className="rnd-chart-tip">
              {clockTime(hovered.t)} · {fmtPct(hovered.pct)}
            </text>
          </g>
        )}
      </svg>
      <p className="rnd-chart-note">
        {samples.length < 2 ? 'Reading the pool price every 5 seconds; the line fills in while this page is open. ' : ''}
        {phase}
      </p>
    </div>
  )
}

function nearest(pts: { t: number; pct: number }[], t: number) {
  let best: { t: number; pct: number } | undefined
  for (const q of pts) if (!best || Math.abs(q.t - t) < Math.abs(best.t - t)) best = q
  return best
}
