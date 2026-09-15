import { describe, it, expect } from 'vitest'
import { settlementGasLimit, RHC_SETTLEMENT_GAS } from './settlementGas.js'

describe('settlementGasLimit', () => {
  it('scales with match count instead of a flat ceiling', () => {
    const one = settlementGasLimit(1, RHC_SETTLEMENT_GAS)
    const ten = settlementGasLimit(10, RHC_SETTLEMENT_GAS)
    expect(ten).toBeGreaterThan(one)
  })

  it('covers the measured mainnet figures with headroom, not just the forge bench', () => {
    // docs/rhc/measurements/README.md: 84,935 fixed + 162,029 per match,
    // measured against a live mainnet pool's observation ring - dearer than
    // the forge bench (129,675), which is what a limit sized off the bench
    // alone would have missed.
    const measuredFixed = 84_935n
    const measuredPerMatch = 162_029n
    for (const n of [1, 5, 13, 25]) {
      const limit = settlementGasLimit(n, RHC_SETTLEMENT_GAS)
      const measured = measuredFixed + measuredPerMatch * BigInt(n)
      expect(limit).toBeGreaterThan(measured)
    }
  })

  it('a 13-match batch - one MAX_BET order can create up to 8 PvP matches on its own, so two such orders due at once already exceeds this - no longer reverts against the old flat 1.8M ceiling', () => {
    const limit = settlementGasLimit(13, RHC_SETTLEMENT_GAS)
    const oldFixedCeiling = 1_800_000n
    const measured = 84_935n + 162_029n * 13n // ~2.19M, > the old ceiling
    expect(measured).toBeGreaterThan(oldFixedCeiling) // sanity: this is the batch size that used to loop forever
    expect(limit).toBeGreaterThan(measured)
  })

  it('a small batch is not billed the old ceiling it never needed', () => {
    // The old code pinned 1.8M for a batch of 1 just as much as a batch of
    // 25. Wallet balance isn't spent on an unused gas limit, but a limit
    // this far above what a small batch needs hides real regressions in
    // measurement (nothing would ever run close enough to notice one).
    const limit = settlementGasLimit(1, RHC_SETTLEMENT_GAS)
    expect(limit).toBeLessThan(1_800_000n)
  })

  it('rejects a non-positive match count - callers already skip empty batches before reaching here', () => {
    expect(() => settlementGasLimit(0, RHC_SETTLEMENT_GAS)).toThrow()
    expect(() => settlementGasLimit(-1, RHC_SETTLEMENT_GAS)).toThrow()
  })
})
