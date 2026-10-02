import type { RoundTimes } from './roundMath'

/**
 * The price of a round's coin against its strike, in the units the contract
 * decides with: Uniswap v3 ticks. A tick is a price step of 0.01%; UP means
 * the coin got dearer in WETH, which is a higher tick when WETH is token1 and a
 * lower one when it is token0. `signedTick` folds that in, so from here on
 * "higher" always means UP.
 */
export interface TickSample {
  /** Chain time, seconds. */
  t: number
  /** Signed tick: higher is UP. */
  tick: number
}

export const signedTick = (tick: number, wethIsToken0: boolean): number => (wethIsToken0 ? -tick : tick)

/** Percent price change from `ref` to `tick` (1 tick = 0.01%). */
export const pctFromTicks = (tick: number, ref: number): number => (Math.pow(1.0001, tick - ref) - 1) * 100

export const fmtPct = (x: number): string => `${x > 0 ? '+' : ''}${x.toFixed(Math.abs(x) < 0.1 ? 3 : 2)}%`

export type Reference =
  /** The contract fixed the strike. */
  | { kind: 'fixed'; tick: number }
  /** Inside the strike window: the mean of what this page sampled so far. */
  | { kind: 'averaging'; tick: number }
  /** Settled: strike and exit both known. */
  | { kind: 'settled'; tick: number; exit: number }
  /** Before the strike window: the strike does not exist yet. */
  | { kind: 'pending' }

export function referenceOf(i: {
  times: RoundTimes
  now: number
  strikeFixed: boolean
  entryTick: number
  exitTick: number
  outcome: number
  samples: TickSample[]
}): Reference {
  if (i.outcome !== 0 && i.strikeFixed) return { kind: 'settled', tick: i.entryTick, exit: i.exitTick }
  if (i.strikeFixed) return { kind: 'fixed', tick: i.entryTick }
  if (i.now >= i.times.strikeStart) {
    const inWindow = i.samples.filter((s) => s.t >= i.times.strikeStart && s.t < i.times.strikeEnd)
    if (inWindow.length) return { kind: 'averaging', tick: inWindow.reduce((a, s) => a + s.tick, 0) / inWindow.length }
  }
  return { kind: 'pending' }
}

/** Where a sample sits against the reference, for the headline: percent, or null while there is no strike. */
export function vsReference(latest: TickSample | undefined, ref: Reference): number | null {
  if (!latest || ref.kind === 'pending') return null
  return pctFromTicks(latest.tick, ref.tick)
}

/**
 * The chart's y-range in percent around the reference (0): symmetric, never
 * narrower than ±floor, so a flat price does not look like a cliff.
 */
export function yRange(pcts: number[], floor = 0.25): number {
  let m = floor
  for (const p of pcts) if (Number.isFinite(p) && Math.abs(p) > m) m = Math.abs(p)
  return m * 1.15
}
