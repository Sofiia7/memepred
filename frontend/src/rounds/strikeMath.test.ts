import { describe, expect, it } from 'vitest'
import { fmtPct, pctFromTicks, referenceOf, signedTick, vsReference, yRange } from './strikeMath'
import { T_TIMES } from './testFixtures'

describe('ticks against the strike', () => {
  it('a tick is 0.01%, and UP is a higher signed tick whichever side WETH is on', () => {
    expect(pctFromTicks(100, 0)).toBeCloseTo(1.005, 2)
    expect(pctFromTicks(-200, 0)).toBeCloseTo(-1.98, 2)
    expect(signedTick(-200, true)).toBe(200) // WETH token0: the coin got dearer when the tick fell
    expect(signedTick(-200, false)).toBe(-200)
    expect(fmtPct(0.4213)).toBe('+0.42%')
    expect(fmtPct(-0.0312)).toBe('-0.031%')
  })
  it('the reference: none before the strike window, the window mean inside it, the contract strike once fixed, both after settling', () => {
    const base = { times: T_TIMES, strikeFixed: false, entryTick: 0, exitTick: 0, outcome: 0, samples: [] as { t: number; tick: number }[] }
    expect(referenceOf({ ...base, now: T_TIMES.closeAt + 10 })).toEqual({ kind: 'pending' })
    const samples = [{ t: T_TIMES.strikeStart - 5, tick: 1000 }, { t: T_TIMES.strikeStart + 5, tick: 100 }, { t: T_TIMES.strikeStart + 65, tick: 300 }]
    expect(referenceOf({ ...base, now: T_TIMES.strikeStart + 70, samples })).toEqual({ kind: 'averaging', tick: 200 })
    expect(referenceOf({ ...base, now: T_TIMES.strikeEnd + 30, strikeFixed: true, entryTick: 250, samples })).toEqual({ kind: 'fixed', tick: 250 })
    expect(referenceOf({ ...base, now: T_TIMES.settleAt + 30, strikeFixed: true, entryTick: 250, exitTick: 450, outcome: 1, samples })).toEqual({ kind: 'settled', tick: 250, exit: 450 })
  })
  it('the headline and the y-range', () => {
    expect(vsReference({ t: 1, tick: 150 }, { kind: 'fixed', tick: 100 })).toBeCloseTo(0.5, 2)
    expect(vsReference({ t: 1, tick: 150 }, { kind: 'pending' })).toBeNull()
    expect(vsReference(undefined, { kind: 'fixed', tick: 100 })).toBeNull()
    expect(yRange([0.1, -0.05])).toBeCloseTo(0.2875, 4)
    expect(yRange([2, -0.5])).toBeCloseTo(2.3, 4)
  })
})
