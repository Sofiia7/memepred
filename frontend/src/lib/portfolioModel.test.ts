// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  BET_OUTCOME_LABEL,
  betOutcome,
  betUnmatched,
  isClaimableBet,
  type BetLike,
} from './portfolioModel'

/** A settled winner that won everything: 0.01 staked, 0.0196 paid (2x less 2%). */
const bet = (over: Partial<BetLike> = {}): BetLike => ({
  order_id: '5',
  amount_usdc: '0.01',
  filled_amount: '0.01',
  payout_usdc: '0.0196',
  status: 'SETTLED',
  won: true,
  tied: false,
  claimed: false,
  ...over,
})

describe('betOutcome (audit U08)', () => {
  it('open while PENDING or MATCHED', () => {
    expect(betOutcome(bet({ status: 'PENDING', won: null, payout_usdc: null }))).toBe('open')
    expect(betOutcome(bet({ status: 'MATCHED', won: null, payout_usdc: null }))).toBe('open')
  })

  it('win: everything won and paid about twice the stake', () => {
    expect(betOutcome(bet())).toBe('win')
    expect(betOutcome(bet({ status: 'CLAIMED', claimed: true }))).toBe('win')
    // An LP-matched win pays 1.96x; a PvP one up to 1.98x. Both are wins.
    expect(betOutcome(bet({ payout_usdc: '0.0198' }))).toBe('win')
  })

  it('mixed, NOT win: one match won but the order paid clearly less than a full win', () => {
    // Two matches of 0.01, one won (0.0196), one lost: 0.02 at risk, 0.0196 paid.
    expect(betOutcome(bet({ amount_usdc: '0.02', filled_amount: '0.02', payout_usdc: '0.0196' }))).toBe('mixed')
  })

  it('mixed when a win comes with a tie', () => {
    expect(betOutcome(bet({ tied: true }))).toBe('mixed')
  })

  it('loss: nothing won, nothing tied', () => {
    expect(betOutcome(bet({ won: false, payout_usdc: '0' }))).toBe('loss')
    expect(betOutcome(bet({ won: false, payout_usdc: null, status: 'CLAIMED', claimed: true }))).toBe('loss')
  })

  it('tie: only ties, no win', () => {
    expect(betOutcome(bet({ won: false, tied: true, payout_usdc: '0' }))).toBe('tie')
  })

  it('refunded: REFUNDED with no winnings', () => {
    expect(betOutcome(bet({ status: 'REFUNDED', won: false, payout_usdc: '0' }))).toBe('refunded')
    expect(betOutcome(bet({ status: 'REFUNDED', won: false, payout_usdc: null }))).toBe('refunded')
  })

  it('a REFUNDED order that still holds winnings is mixed (a win and a refund)', () => {
    expect(betOutcome(bet({ status: 'REFUNDED', payout_usdc: '0.0196' }))).toBe('mixed')
  })

  it('open when a settled row has no verdict yet (the indexer is behind)', () => {
    expect(betOutcome(bet({ won: null, payout_usdc: null }))).toBe('open')
  })

  it('has a label for every outcome, none of them "WON"', () => {
    expect(Object.values(BET_OUTCOME_LABEL)).toEqual(['OPEN', 'WIN', 'LOSS', 'TIE', 'MIXED', 'REFUNDED'])
  })
})

describe('isClaimableBet: what goes under "Ready to claim"', () => {
  it('a settled winner with a payout that has not been claimed', () => {
    expect(isClaimableBet(bet())).toBe(true)
  })

  it('a REFUNDED order that still has a payout (audit A04) - today only SETTLED was listed', () => {
    expect(isClaimableBet(bet({ status: 'REFUNDED', payout_usdc: '0.0196' }))).toBe(true)
  })

  it('not a REFUNDED order without one', () => {
    expect(isClaimableBet(bet({ status: 'REFUNDED', payout_usdc: '0' }))).toBe(false)
    expect(isClaimableBet(bet({ status: 'REFUNDED', payout_usdc: null }))).toBe(false)
  })

  it('not a loss, not something already claimed, not a running order', () => {
    expect(isClaimableBet(bet({ won: false, payout_usdc: '0' }))).toBe(false)
    expect(isClaimableBet(bet({ status: 'CLAIMED', claimed: true }))).toBe(false)
    expect(isClaimableBet(bet({ claimed: true }))).toBe(false)
    expect(isClaimableBet(bet({ status: 'PENDING', won: null, payout_usdc: null }))).toBe(false)
    expect(isClaimableBet(bet({ status: 'MATCHED', won: null, payout_usdc: null }))).toBe(false)
  })

  it('not a row without an order id (nothing to call claim() with)', () => {
    expect(isClaimableBet(bet({ order_id: null }))).toBe(false)
  })

  it('an unknown payout falls back to "won"', () => {
    expect(isClaimableBet(bet({ payout_usdc: null }))).toBe(true)
    expect(isClaimableBet(bet({ payout_usdc: null, won: false }))).toBe(false)
  })
})

describe('betUnmatched: orders with a remainder that can be cancelled', () => {
  it('a running order with part of the stake unmatched', () => {
    expect(betUnmatched(bet({ status: 'PENDING', won: null, filled_amount: '0.004' }))).toBeCloseTo(0.006, 9)
  })

  it('a never matched order has its whole stake unmatched', () => {
    expect(betUnmatched(bet({ status: 'PENDING', won: null, filled_amount: '0' }))).toBeCloseTo(0.01, 9)
  })

  it('nothing for a fully matched one, and float dust is not a remainder', () => {
    expect(betUnmatched(bet({ status: 'MATCHED', won: null, filled_amount: '0.01' }))).toBe(0)
    expect(
      betUnmatched(bet({ status: 'MATCHED', won: null, amount_usdc: '0.3', filled_amount: String(0.1 + 0.2) })),
    ).toBe(0)
  })

  it('nothing once the API says the tail was returned, or the order is over', () => {
    expect(betUnmatched(bet({ status: 'PENDING', won: null, filled_amount: '0.004', unmatched_refunded: true }))).toBe(0)
    expect(betUnmatched(bet({ status: 'SETTLED', filled_amount: '0.004' }))).toBe(0)
    expect(betUnmatched(bet({ status: 'REFUNDED', filled_amount: '0' }))).toBe(0)
  })

  it('no evidence of a tail without a fill figure, so no cancel is offered', () => {
    expect(betUnmatched(bet({ status: 'MATCHED', won: null, filled_amount: null }))).toBe(0)
    expect(betUnmatched(bet({ status: 'MATCHED', won: null, filled_amount: undefined }))).toBe(0)
  })

  it('nothing without an order id', () => {
    expect(betUnmatched(bet({ status: 'PENDING', won: null, filled_amount: '0', order_id: null }))).toBe(0)
  })
})
