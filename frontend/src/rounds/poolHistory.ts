import { signedTick, type TickSample } from './strikeMath'

/** Historical points are interval averages from the pool's own oracle, never invented prices. */
export function oracleSamples(secondsAgos: readonly number[], cumulatives: readonly bigint[], timestamp: number, wethIsToken0: boolean): TickSample[] {
  if (secondsAgos.length !== cumulatives.length) return []
  const samples: TickSample[] = []
  for (let i = 0; i < secondsAgos.length - 1; i++) {
    const dt = secondsAgos[i] - secondsAgos[i + 1]
    if (dt <= 0) return []
    const delta = cumulatives[i + 1] - cumulatives[i]
    // Match Uniswap's floor for negative ticks rather than BigInt's truncation toward zero.
    let tick = delta / BigInt(dt)
    if (delta < 0n && delta % BigInt(dt) !== 0n) tick--
    samples.push({ t: timestamp - secondsAgos[i + 1], tick: signedTick(Number(tick), wethIsToken0) })
  }
  return samples
}

/** Keep live reads when historical averages overlap them, and retain chronological order. */
export function mergePoolSamples(history: TickSample[], live: TickSample[], cutoff: number): TickSample[] {
  const byTime = new Map(history.map((s) => [s.t, s]))
  for (const s of live) byTime.set(s.t, s)
  return [...byTime.values()].filter((s) => s.t >= cutoff).sort((a, b) => a.t - b.t)
}
