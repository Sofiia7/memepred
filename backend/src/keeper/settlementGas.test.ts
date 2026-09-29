import { describe, it, expect } from 'vitest'
import { settlementGasLimit, RHC_SETTLEMENT_GAS, escalatedGas, revertPauseMs, REVERT_PAUSE_AFTER } from './settlementGas.js'

describe('settlementGasLimit', () => {
  it('scales with match count instead of a flat ceiling', () => {
    const one = settlementGasLimit(1, RHC_SETTLEMENT_GAS)
    const ten = settlementGasLimit(10, RHC_SETTLEMENT_GAS)
    expect(ten).toBeGreaterThan(one)
  })

  it('a one-match batch clears the dearest live settlement at its PEAK, not just its gas used', () => {
    // 2026-09-29, live testnet: 293,038 gas used for a PvP settle. Gas used is
    // after the storage refund (up to a fifth), so the peak is about used / 0.8.
    // The keeper used to attach 360,000 here and reverted out of gas 20 times.
    const peak = (293_038n * 10n) / 8n
    expect(settlementGasLimit(1, RHC_SETTLEMENT_GAS)).toBeGreaterThan(peak)
    expect(settlementGasLimit(1, RHC_SETTLEMENT_GAS)).toBeGreaterThan(360_000n)
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

describe('escalatedGas (a reverted settle is not resent with the same limit)', () => {
  it('keeps the base when nothing has reverted', () => {
    expect(escalatedGas(500_000n, 0)).toBe(500_000n)
  })

  it('asks for half as much again after each consecutive revert', () => {
    expect(escalatedGas(500_000n, 1)).toBe(750_000n)
    expect(escalatedGas(500_000n, 2)).toBe(1_125_000n)
  })

  it('never asks for more than three times the base', () => {
    expect(escalatedGas(500_000n, 3)).toBe(1_500_000n)
    expect(escalatedGas(500_000n, 10)).toBe(1_500_000n)
  })
})

describe('revertPauseMs (a market that keeps reverting is left alone, not paid for every tick)', () => {
  it('does not pause before the third revert in a row', () => {
    for (let s = 0; s < REVERT_PAUSE_AFTER; s++) expect(revertPauseMs(s)).toBe(0)
  })

  it('pauses 30 s at the third, doubling, capped at five minutes', () => {
    expect(revertPauseMs(REVERT_PAUSE_AFTER)).toBe(30_000)
    expect(revertPauseMs(REVERT_PAUSE_AFTER + 1)).toBe(60_000)
    expect(revertPauseMs(REVERT_PAUSE_AFTER + 2)).toBe(120_000)
    expect(revertPauseMs(REVERT_PAUSE_AFTER + 20)).toBe(300_000)
  })
})
