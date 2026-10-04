import { describe, expect, it } from 'vitest'
import { mergePoolSamples, oracleSamples } from './poolHistory'

describe('pool oracle history', () => {
  it('reconstructs actual interval ticks, floors negative averages, and reverses token0 quotes', () => {
    const ago = [40, 20, 0]
    const cumulative = [0n, 400n, 379n]
    expect(oracleSamples(ago, cumulative, 1000, false)).toEqual([{ t: 980, tick: 20 }, { t: 1000, tick: -2 }])
    expect(oracleSamples(ago, cumulative, 1000, true)).toEqual([{ t: 980, tick: -20 }, { t: 1000, tick: 2 }])
  })
  it('rejects incomplete or nonmonotonic oracle data', () => {
    expect(oracleSamples([20, 0], [0n], 1000, false)).toEqual([])
    expect(oracleSamples([0, 20], [0n, 0n], 1000, false)).toEqual([])
  })
  it('preserves live prices over historical averages and trims old points', () => {
    expect(mergePoolSamples([{ t: 1, tick: 5 }, { t: 3, tick: 9 }], [{ t: 3, tick: 10 }, { t: 2, tick: 8 }], 2))
      .toEqual([{ t: 2, tick: 8 }, { t: 3, tick: 10 }])
  })
})
