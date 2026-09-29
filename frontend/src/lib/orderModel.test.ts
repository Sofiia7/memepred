// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  aggregateOutcome,
  canCancelRemainder,
  canRefundExpired,
  claimBlocker,
  claimableNow,
  findStuckMatchId,
  formatCountdown,
  formatHoursMinutes,
  isOrderTrader,
  matchWindowLeft,
  mergeMatchTiming,
  MATCH_OUTCOME_LABEL,
  numberToUnits,
  orderExists,
  orderPhase,
  settlementMessage,
  settlementStatus,
  unmatchedRemainder,
  ZERO_ADDRESS,
  type MatchTiming,
  type OrderLike,
} from './orderModel'
import { MATCH_TIMEOUT_SEC, SETTLE_GRACE_SEC } from './orderTiming'

const NOW = 1_800_000_000
const TRADER = '0x00000000000000000000000000000000000000bb'
const OTHER = '0x00000000000000000000000000000000000000cc'

/** A fully filled order, MATCHED, one settlement pending. Tests override what they care about. */
const order = (over: Partial<OrderLike> = {}): OrderLike & { trader: string } => ({
  trader: TRADER,
  amount: 10n,
  filledAmount: 10n,
  status: 1,
  placedAt: BigInt(NOW - 100),
  pendingSettlements: 1n,
  payout: 0n,
  unmatchedRefunded: false,
  ...over,
})

describe('findStuckMatchId', () => {
  const stuckAt = NOW - SETTLE_GRACE_SEC - 3600

  it('finds a later match that is actually stuck, not just the first one', () => {
    const matches: MatchTiming[] = [
      { matchId: '7', settled: true, settleAt: NOW - 3600 },
      { matchId: '9', settled: false, settleAt: stuckAt },
    ]
    expect(findStuckMatchId(matches, NOW)).toBe(9n)
  })

  it('returns undefined for an empty list', () => {
    expect(findStuckMatchId([], NOW)).toBeUndefined()
  })

  it('is strict about the grace, exactly like the contract (block.timestamp > settleAt + grace)', () => {
    const m: MatchTiming[] = [{ matchId: '3', settled: false, settleAt: NOW - SETTLE_GRACE_SEC }]
    expect(findStuckMatchId(m, NOW)).toBeUndefined()
    expect(findStuckMatchId(m, NOW + 1)).toBe(3n)
  })

  it('never returns a settled match, however old', () => {
    const m: MatchTiming[] = [{ matchId: '3', settled: true, settleAt: stuckAt }]
    expect(findStuckMatchId(m, NOW)).toBeUndefined()
  })

  it('returns the first stuck match when several are', () => {
    const m: MatchTiming[] = [
      { matchId: '4', settled: false, settleAt: stuckAt },
      { matchId: '5', settled: false, settleAt: stuckAt - 10 },
    ]
    expect(findStuckMatchId(m, NOW)).toBe(4n)
  })

  it('handles ids beyond Number.MAX_SAFE_INTEGER', () => {
    const m: MatchTiming[] = [{ matchId: '18446744073709551617', settled: false, settleAt: stuckAt }]
    expect(findStuckMatchId(m, NOW)).toBe(18446744073709551617n)
  })
})

describe('mergeMatchTiming', () => {
  const first = (settled: boolean, settleAt: number) => ({ matchId: 7n, settled, settleAt: BigInt(settleAt) })

  it('with an empty list, the chain match becomes the whole list (the single-match fallback)', () => {
    const merged = mergeMatchTiming([], first(false, NOW - SETTLE_GRACE_SEC - 5))
    expect(merged).toEqual([{ matchId: '7', settled: false, settleAt: NOW - SETTLE_GRACE_SEC - 5 }])
    expect(findStuckMatchId(merged, NOW)).toBe(7n)
  })

  it('never offers Recover for a match that has settled, even a day and a half ago', () => {
    // The audit's case: match 1 settled long ago, the list is empty or lagging.
    const merged = mergeMatchTiming([], first(true, NOW - 36 * 3600))
    expect(findStuckMatchId(merged, NOW)).toBeUndefined()
    expect(settlementStatus(merged, NOW)).toEqual({ kind: 'none' })
  })

  it('lets the chain override a lagging backend list for the first match', () => {
    const api = [{ matchId: '7', settled: false, settleAt: NOW - SETTLE_GRACE_SEC - 60 }]
    const merged = mergeMatchTiming(api, first(true, NOW - SETTLE_GRACE_SEC - 60))
    expect(merged.find((m) => m.matchId === '7')?.settled).toBe(true)
    expect(findStuckMatchId(merged, NOW)).toBeUndefined()
  })

  it('keeps the other matches of the list and sorts by settleAt', () => {
    const api = [
      { matchId: '9', settled: false, settleAt: NOW + 50 },
      { matchId: '8', settled: false, settleAt: NOW + 10 },
    ]
    const merged = mergeMatchTiming(api, first(true, NOW - 5))
    expect(merged.map((m) => m.matchId)).toEqual(['7', '8', '9'])
  })

  it('is a no-op without a chain match, or with match id 0 (an order nothing matched)', () => {
    const api = [{ matchId: '9', settled: false, settleAt: NOW }]
    expect(mergeMatchTiming(api, undefined)).toBe(api)
    expect(mergeMatchTiming(api, null)).toBe(api)
    expect(mergeMatchTiming(api, { matchId: 0n, settled: false, settleAt: 0n })).toBe(api)
  })

  it('a stuck LATER match still surfaces after the first one settled', () => {
    const api = [
      { matchId: '7', settled: true, settleAt: NOW - SETTLE_GRACE_SEC - 100 },
      { matchId: '9', settled: false, settleAt: NOW - SETTLE_GRACE_SEC - 50 },
    ]
    const merged = mergeMatchTiming(api, first(true, NOW - SETTLE_GRACE_SEC - 100))
    expect(findStuckMatchId(merged, NOW)).toBe(9n)
  })
})

describe('settlementStatus and its message', () => {
  it('is none when nothing is unsettled', () => {
    expect(settlementStatus([], NOW)).toEqual({ kind: 'none' })
    expect(settlementStatus([{ matchId: '1', settled: true, settleAt: NOW - 5 }], NOW)).toEqual({ kind: 'none' })
    expect(settlementMessage({ kind: 'none' })).toBeNull()
  })

  it('counts down to settleAt: "Result in mm:ss"', () => {
    const s = settlementStatus([{ matchId: '1', settled: false, settleAt: NOW + 252 }], NOW)
    expect(s).toMatchObject({ kind: 'countdown', secondsLeft: 252, openCount: 1 })
    expect(settlementMessage(s)).toEqual({ headline: 'Result in 04:12' })
  })

  it('counts down to the NEXT match when several are open, and says so', () => {
    const s = settlementStatus(
      [
        { matchId: '2', settled: false, settleAt: NOW + 120 },
        { matchId: '1', settled: false, settleAt: NOW + 30 },
      ],
      NOW,
    )
    expect(s).toMatchObject({ kind: 'countdown', matchId: '1', secondsLeft: 30, openCount: 2 })
    expect(settlementMessage(s)?.headline).toBe('Result in 00:30 (next of 2 matches)')
  })

  it('is overdue from settleAt on: waiting for the keeper, with the recover countdown', () => {
    const s = settlementStatus([{ matchId: '1', settled: false, settleAt: NOW }], NOW)
    expect(s).toMatchObject({ kind: 'overdue', overdueBy: 0, recoverInSec: SETTLE_GRACE_SEC })
    expect(settlementMessage(s)).toEqual({
      headline: 'Waiting for the keeper to post the result',
      note: 'The keeper settles the match, or refunds both stakes if the price cannot be determined.',
      recover: 'Recover available in 24:00',
    })
  })

  it('shows how overdue it is once that is worth saying, and counts the recover time down', () => {
    const s = settlementStatus([{ matchId: '1', settled: false, settleAt: NOW - 3600 }], NOW)
    expect(settlementMessage(s)).toEqual({
      headline: 'Waiting for the keeper to post the result (overdue 1:00:00)',
      note: 'The keeper settles the match, or refunds both stakes if the price cannot be determined.',
      recover: 'Recover available in 23:00',
    })
  })

  it('is recoverable only strictly past the 24 hour grace', () => {
    const at = { matchId: '1', settled: false, settleAt: NOW - SETTLE_GRACE_SEC }
    expect(settlementStatus([at], NOW).kind).toBe('overdue')
    const past = settlementStatus([at], NOW + 1)
    expect(past.kind).toBe('recoverable')
    expect(settlementMessage(past)?.recover).toBeUndefined()
    expect(settlementMessage(past)?.headline).toMatch(/more than 24 hours overdue/)
  })

  it('reports a recoverable match ahead of one that is merely counting down', () => {
    const s = settlementStatus(
      [
        { matchId: '1', settled: false, settleAt: NOW + 60 },
        { matchId: '2', settled: false, settleAt: NOW - SETTLE_GRACE_SEC - 10 },
      ],
      NOW,
    )
    expect(s).toMatchObject({ kind: 'recoverable', matchId: '2' })
  })
})

describe('countdown formatting', () => {
  it('formatCountdown is mm:ss, and h:mm:ss from an hour up', () => {
    expect(formatCountdown(0)).toBe('00:00')
    expect(formatCountdown(59)).toBe('00:59')
    expect(formatCountdown(252)).toBe('04:12')
    expect(formatCountdown(3599)).toBe('59:59')
    expect(formatCountdown(3600)).toBe('1:00:00')
    expect(formatCountdown(3725)).toBe('1:02:05')
    expect(formatCountdown(-5)).toBe('00:00')
  })

  it('formatHoursMinutes is hh:mm, rounded up so it never reads 00:00 with time left', () => {
    expect(formatHoursMinutes(0)).toBe('00:00')
    expect(formatHoursMinutes(1)).toBe('00:01')
    expect(formatHoursMinutes(60)).toBe('00:01')
    expect(formatHoursMinutes(61)).toBe('00:02')
    expect(formatHoursMinutes(85_260)).toBe('23:41')
    expect(formatHoursMinutes(SETTLE_GRACE_SEC)).toBe('24:00')
    expect(formatHoursMinutes(-1)).toBe('00:00')
  })
})

describe('the unmatched remainder, cancel and refund', () => {
  it('unmatchedRemainder: the tail, or nothing once it was returned', () => {
    expect(unmatchedRemainder(order({ amount: 10n, filledAmount: 4n }))).toBe(6n)
    expect(unmatchedRemainder(order({ amount: 10n, filledAmount: 0n }))).toBe(10n)
    expect(unmatchedRemainder(order({ amount: 10n, filledAmount: 10n }))).toBe(0n)
    expect(unmatchedRemainder(order({ amount: 10n, filledAmount: 4n, unmatchedRefunded: true }))).toBe(0n)
    expect(unmatchedRemainder(order({ amount: 10n, filledAmount: 12n }))).toBe(0n)
  })

  it('canCancelRemainder: the trader, while something is unmatched, PENDING or MATCHED', () => {
    const partial = order({ status: 0, filledAmount: 4n })
    expect(canCancelRemainder(partial, TRADER)).toBe(true)
    // Case-insensitive on the address.
    expect(canCancelRemainder(partial, TRADER.toUpperCase().replace('0X', '0x'))).toBe(true)
    // Nobody else, and nobody who is not connected.
    expect(canCancelRemainder(partial, OTHER)).toBe(false)
    expect(canCancelRemainder(partial, undefined)).toBe(false)
    expect(canCancelRemainder(partial, null)).toBe(false)
  })

  it('canCancelRemainder: a fully filled order has nothing to cancel ("nothing to refund")', () => {
    expect(canCancelRemainder(order({ status: 1, filledAmount: 10n }), TRADER)).toBe(false)
  })

  it('canCancelRemainder: not after the tail was returned ("already refunded")', () => {
    expect(canCancelRemainder(order({ status: 0, filledAmount: 4n, unmatchedRefunded: true }), TRADER)).toBe(false)
  })

  it('canCancelRemainder: not once the order left PENDING/MATCHED ("wrong status")', () => {
    for (const status of [2, 3, 4]) {
      expect(canCancelRemainder(order({ status, filledAmount: 0n }), TRADER)).toBe(false)
    }
  })

  it('canCancelRemainder: a never-matched order can be cancelled', () => {
    expect(canCancelRemainder(order({ status: 0, filledAmount: 0n }), TRADER)).toBe(true)
  })

  it('canRefundExpired: strictly after the 5 minute window, and only with something unmatched', () => {
    const o = order({ status: 0, filledAmount: 0n, placedAt: BigInt(NOW - MATCH_TIMEOUT_SEC) })
    expect(canRefundExpired(o, NOW)).toBe(false) // block.timestamp > placedAt + timeout
    expect(canRefundExpired(o, NOW + 1)).toBe(true)
    expect(canRefundExpired(order({ status: 1, placedAt: BigInt(NOW - 10_000) }), NOW)).toBe(false) // fully filled
    expect(canRefundExpired(order({ status: 0, filledAmount: 0n, unmatchedRefunded: true, placedAt: BigInt(NOW - 10_000) }), NOW)).toBe(false)
  })

  it('matchWindowLeft counts down and stops at zero', () => {
    const o = order({ placedAt: BigInt(NOW - 100) })
    expect(matchWindowLeft(o, NOW)).toBe(MATCH_TIMEOUT_SEC - 100)
    expect(matchWindowLeft(o, NOW + 1000)).toBe(0)
  })
})

describe('claim gating', () => {
  it('claimableNow mirrors claim(): settled, nothing pending, a payout', () => {
    expect(claimableNow(order({ status: 2, pendingSettlements: 0n, payout: 5n }))).toBe(true)
  })

  it('a REFUNDED order that still holds winnings is claimable (audit A04)', () => {
    expect(claimableNow(order({ status: 4, pendingSettlements: 0n, payout: 20n }))).toBe(true)
  })

  it('not while a match is pending, not without a payout, not twice', () => {
    expect(claimableNow(order({ status: 2, pendingSettlements: 1n, payout: 5n }))).toBe(false)
    expect(claimableNow(order({ status: 2, pendingSettlements: 0n, payout: 0n }))).toBe(false)
    expect(claimableNow(order({ status: 3, pendingSettlements: 0n, payout: 5n }))).toBe(false)
  })

  it('a partly filled order whose filled part won is NOT claimable while its tail is open', () => {
    const o = order({ status: 0, filledAmount: 4n, pendingSettlements: 0n, payout: 7n })
    expect(claimableNow(o)).toBe(false)
    expect(claimBlocker(o)).toBe('open-remainder')
  })

  it('...and becomes claimable once the tail is returned', () => {
    const o = order({ status: 0, filledAmount: 4n, pendingSettlements: 0n, payout: 7n, unmatchedRefunded: true })
    expect(claimableNow(o)).toBe(true)
    expect(claimBlocker(o)).toBe('none')
  })

  it('claimBlocker names the reason for each blocked case', () => {
    expect(claimBlocker(order({ status: 3, payout: 5n }))).toBe('claimed')
    expect(claimBlocker(order({ status: 2, pendingSettlements: 0n, payout: 0n }))).toBe('no-payout')
    expect(claimBlocker(order({ status: 1, pendingSettlements: 2n, payout: 5n }))).toBe('matches-running')
    expect(claimBlocker(order({ status: 2, pendingSettlements: 0n, payout: 5n }))).toBe('none')
  })
})

describe('identity', () => {
  it('orderExists: getOrder() of an unused id is a zeroed struct', () => {
    expect(orderExists({ trader: ZERO_ADDRESS })).toBe(false)
    expect(orderExists({ trader: ZERO_ADDRESS.toUpperCase().replace('0X', '0x') })).toBe(false)
    expect(orderExists({ trader: TRADER })).toBe(true)
  })

  it('isOrderTrader: only the order\'s own trader, never on a zeroed order', () => {
    expect(isOrderTrader({ trader: TRADER }, TRADER)).toBe(true)
    expect(isOrderTrader({ trader: TRADER }, OTHER)).toBe(false)
    expect(isOrderTrader({ trader: TRADER }, undefined)).toBe(false)
    expect(isOrderTrader({ trader: ZERO_ADDRESS }, ZERO_ADDRESS)).toBe(false)
  })
})

describe('orderPhase', () => {
  it('reads the lifecycle from the fields, not from the enum alone', () => {
    expect(orderPhase(order({ status: 0, filledAmount: 0n }))).toBe('searching')
    expect(orderPhase(order({ status: 0, filledAmount: 4n }))).toBe('partial')
    expect(orderPhase(order({ status: 1, filledAmount: 10n }))).toBe('running')
    // The tail came back while matches were still pending: no longer "searching".
    expect(orderPhase(order({ status: 0, filledAmount: 4n, unmatchedRefunded: true }))).toBe('running')
    expect(orderPhase(order({ status: 2 }))).toBe('settled')
    expect(orderPhase(order({ status: 3 }))).toBe('claimed')
    expect(orderPhase(order({ status: 4 }))).toBe('refunded')
  })
})

describe('aggregateOutcome', () => {
  it('names an order by ALL of its matches', () => {
    expect(aggregateOutcome([])).toBe('open')
    expect(aggregateOutcome(['won'])).toBe('win')
    expect(aggregateOutcome(['won', 'won'])).toBe('win')
    expect(aggregateOutcome(['lost', 'lost'])).toBe('loss')
    expect(aggregateOutcome(['tied'])).toBe('tie')
    expect(aggregateOutcome(['emergency_refunded'])).toBe('refunded')
  })

  it('is mixed for any combination, and open while a match is still running', () => {
    expect(aggregateOutcome(['won', 'lost'])).toBe('mixed')
    expect(aggregateOutcome(['tied', 'won'])).toBe('mixed')
    expect(aggregateOutcome(['won', 'emergency_refunded'])).toBe('mixed')
    expect(aggregateOutcome(['won', 'pending'])).toBe('open')
  })

  it('labels the resolver refund as "no price available", not as an emergency', () => {
    expect(MATCH_OUTCOME_LABEL.emergency_refunded).toBe('refunded (no price available)')
    expect(MATCH_OUTCOME_LABEL.tied).toBe('tied - refunded')
  })
})

describe('numberToUnits', () => {
  it('converts a JSON number back to base units', () => {
    expect(numberToUnits(5, 6)).toBe(5_000_000n)
    expect(numberToUnits(1234.5678, 6)).toBe(1_234_567_800n)
    expect(numberToUnits(0.0196, 18)).toBe(19_600_000_000_000_000n)
  })

  it('is not thrown by float noise', () => {
    expect(numberToUnits(0.019600000000000002, 18)).toBe(19_600_000_000_000_000n)
    expect(numberToUnits(0.1 + 0.2, 18)).toBe(300_000_000_000_000_000n)
  })

  it('handles tiny and empty values', () => {
    expect(numberToUnits(1e-7, 18)).toBe(100_000_000_000n)
    expect(numberToUnits(0, 18)).toBe(0n)
    expect(numberToUnits(-1, 18)).toBe(0n)
    expect(numberToUnits(Number.NaN, 18)).toBe(0n)
  })
})
