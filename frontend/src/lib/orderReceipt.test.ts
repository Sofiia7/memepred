import { describe, it, expect } from 'vitest'
import { buildReceipt, formatAmount, formatPercent, formatSigned, type ReceiptMatch } from './orderReceipt'

/**
 * Whole-currency figures the way the contracts produce them: a 0.01 bet against
 * another trader pays 0.0198 (pot 0.02 less 1%), against the LP vault 0.0196
 * (less 1% protocol and 1% LP taker) - the same numbers scripts/rhc/e2e-verify
 * measured on the chain on 2026-09-29.
 */

const won = (amount: number): ReceiptMatch => ({ amount, outcome: 'won' })
const lost = (amount: number): ReceiptMatch => ({ amount, outcome: 'lost' })
const tied = (amount: number): ReceiptMatch => ({ amount, outcome: 'tied' })
const refunded = (amount: number): ReceiptMatch => ({ amount, outcome: 'emergency_refunded' })

describe('buildReceipt', () => {
  it('a win against another trader: 0.01 staked, 0.0198 paid, 0.0002 of fees, +0.0098', () => {
    const r = buildReceipt({ amount: 0.01, filled: 0.01, payout: 0.0198, matches: [won(0.01)] })!
    expect(r.atRisk).toBeCloseTo(0.01, 12)
    expect(r.payout).toBeCloseTo(0.0198, 12)
    expect(r.fees).toBeCloseTo(0.0002, 12)
    expect(r.net).toBeCloseTo(0.0098, 12)
    expect(r.netPct).toBeCloseTo(0.98, 9)
    expect(r.returned).toBe(0)
  })

  it('a win against the LP vault pays 0.0196, so the fees are 0.0004', () => {
    const r = buildReceipt({ amount: 0.01, filled: 0.01, payout: 0.0196, matches: [won(0.01)] })!
    expect(r.fees).toBeCloseTo(0.0004, 12)
    expect(r.net).toBeCloseTo(0.0096, 12)
  })

  it('a loss is the whole stake, with no fee: only the winner pays one', () => {
    const r = buildReceipt({ amount: 0.01, filled: 0.01, payout: 0, matches: [lost(0.01)] })!
    expect(r.payout).toBe(0)
    expect(r.fees).toBe(0)
    expect(r.net).toBeCloseTo(-0.01, 12)
    expect(r.netPct).toBeCloseTo(-1, 12)
  })

  it('a tie has nothing at risk: the stake came back', () => {
    const r = buildReceipt({ amount: 0.01, filled: 0.01, payout: 0, matches: [tied(0.01)] })!
    expect(r.atRisk).toBe(0)
    expect(r.returned).toBeCloseTo(0.01, 12)
    expect(r.net).toBe(0)
    expect(r.netPct).toBeNull()
  })

  it('a win and a loss on one order net against each other', () => {
    // +0.0098 on the win, -0.01 on the loss.
    const r = buildReceipt({ amount: 0.02, filled: 0.02, payout: 0.0198, matches: [won(0.01), lost(0.01)] })!
    expect(r.atRisk).toBeCloseTo(0.02, 12)
    expect(r.net).toBeCloseTo(-0.0002, 12)
    expect(r.fees).toBeCloseTo(0.0002, 12)
  })

  it('a tied or unpriceable match is neither a gain nor a loss, and comes back in full', () => {
    const t = buildReceipt({ amount: 0.02, filled: 0.02, payout: 0.0198, matches: [won(0.01), tied(0.01)] })!
    expect(t.atRisk).toBeCloseTo(0.01, 12)
    expect(t.returned).toBeCloseTo(0.01, 12)
    expect(t.net).toBeCloseTo(0.0098, 12)

    const r = buildReceipt({ amount: 0.02, filled: 0.02, payout: 0.0198, matches: [won(0.01), refunded(0.01)] })!
    expect(r.returned).toBeCloseTo(0.01, 12)
    expect(r.net).toBeCloseTo(0.0098, 12)
  })

  it('the unmatched rest of a partly filled order came back too, and is not part of the result', () => {
    const r = buildReceipt({ amount: 0.02, filled: 0.01, payout: 0.0198, matches: [won(0.01)] })!
    expect(r.returned).toBeCloseTo(0.01, 12)
    expect(r.atRisk).toBeCloseTo(0.01, 12)
    expect(r.net).toBeCloseTo(0.0098, 12)
  })

  describe('says nothing rather than something that might be wrong', () => {
    it('while any match has no result yet', () => {
      expect(
        buildReceipt({ amount: 0.02, filled: 0.02, payout: 0.0198, matches: [won(0.01), { amount: 0.01, outcome: 'pending' }] }),
      ).toBeNull()
    })

    it('when the payout is not known', () => {
      expect(buildReceipt({ amount: 0.01, filled: 0.01, payout: null, matches: [won(0.01)] })).toBeNull()
    })

    it('when there are no matches to read', () => {
      expect(buildReceipt({ amount: 0.01, filled: 0.01, payout: 0, matches: [] })).toBeNull()
    })

    it('when the matches do not add up to what the order says it filled', () => {
      // An indexer that has not caught up yet: one of two matches is missing.
      expect(buildReceipt({ amount: 0.02, filled: 0.02, payout: 0.0198, matches: [won(0.01)] })).toBeNull()
    })

    it('when there is a payout but no win behind it', () => {
      expect(buildReceipt({ amount: 0.01, filled: 0.01, payout: 0.0198, matches: [lost(0.01)] })).toBeNull()
    })

    it('when the win has no payout behind it yet', () => {
      expect(buildReceipt({ amount: 0.01, filled: 0.01, payout: 0, matches: [won(0.01)] })).toBeNull()
    })

    it('when the payout is bigger than the pot', () => {
      expect(buildReceipt({ amount: 0.01, filled: 0.01, payout: 0.03, matches: [won(0.01)] })).toBeNull()
    })

    it('when a win was paid far less than a win pays', () => {
      expect(buildReceipt({ amount: 0.01, filled: 0.01, payout: 0.005, matches: [won(0.01)] })).toBeNull()
    })

    it('for numbers that are not numbers', () => {
      expect(buildReceipt({ amount: NaN, filled: 0.01, payout: 0, matches: [lost(0.01)] })).toBeNull()
      expect(buildReceipt({ amount: 0.01, filled: 0.01, payout: -1, matches: [lost(0.01)] })).toBeNull()
    })
  })
})

describe('formatting', () => {
  it('formatAmount keeps up to five decimals and no trailing zeros', () => {
    expect(formatAmount(0.0198)).toBe('0.0198')
    expect(formatAmount(0.010000000000000002)).toBe('0.01')
    expect(formatAmount(5)).toBe('5')
    expect(formatAmount(0)).toBe('0')
    expect(formatAmount(0.00001)).toBe('0.00001')
    expect(formatAmount(1.23456)).toBe('1.2346')
    expect(formatAmount(123.456)).toBe('123.46')
    expect(formatAmount(NaN)).toBe('-')
  })

  it('formatSigned puts an explicit plus on a gain and never shows a signed zero', () => {
    expect(formatSigned(0.0098)).toBe('+0.0098')
    expect(formatSigned(-0.0002)).toBe('-0.0002')
    expect(formatSigned(0)).toBe('0')
    expect(formatSigned(1e-9)).toBe('0')
    expect(formatSigned(-1e-9)).toBe('0')
  })

  it('formatPercent shows one decimal only when it says something', () => {
    expect(formatPercent(0.98)).toBe('+98%')
    expect(formatPercent(-1)).toBe('-100%')
    expect(formatPercent(0.0049)).toBe('+0.5%')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(0.00001)).toBe('0%')
  })
})
