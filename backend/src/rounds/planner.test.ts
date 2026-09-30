import { describe, it, expect } from 'vitest'
import { getAddress } from 'viem'
import { roundIdOf, type CallDeadlines, type RoundState, type RoundTimes } from './contract.js'
import { planRound, dueAction, deadlineFor, nextDeadline, type RoundMemo, type PlanConfig } from './planner.js'
import { ROUNDS_GAS_FLOOR, bidFor, roundsGasLimit, spendCap, worstCaseWei, receiptCostWei, URGENT_FEE_MULTIPLIER } from './budget.js'

const POOL = getAddress('0x5b0e7a1d2c3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b')
const ID = roundIdOf(POOL, 300, 5_966_666)
/** As roundTimes reports them for the deployment defaults (300 s round, 300 s pause, 300 s strike window). */
const T: RoundTimes = { openAt: 1_789_999_800, closeAt: 1_790_000_100, strikeStart: 1_790_000_400, strikeEnd: 1_790_000_700, settleAt: 1_790_001_000 }
/** As keeperDeadlines reports them for the defaults (ring 900): strikeEnd + 599, settleAt + 839. */
const D: CallDeadlines = { fixStrikeBy: T.strikeEnd + 599, settleBy: T.settleAt + 839 }
/**
 * Tighter deadlines, as a contract with a smaller ring would state them
 * (strikeEnd + 119, settleAt + 359): here fixStrike's deadline falls before
 * settleAt, so a fixStrike can be late while still being the call due.
 */
const TIGHT: CallDeadlines = { fixStrikeBy: T.strikeEnd + 119, settleBy: T.settleAt + 359 }
const GRACE = 86_400
const CFG: PlanConfig = { settleGraceSec: GRACE, graceReserveBps: 2_000n }
const ALLOWANCE = 69_692n * 10n ** 9n // the deploy default: 1 000 000 gas x 0.069692 gwei
const RESERVED_CAP = ALLOWANCE - ALLOWANCE / 5n
const FRESH: RoundMemo = { spentWei: 0n, revertStreak: 0, pausedUntilMs: 0 }

function state(over: Partial<RoundState> = {}): RoundState {
  return {
    roundId: ID, pool: POOL, duration: 300, index: 5_966_666n, times: T,
    committed: 4n * 10n ** 16n, rawUp: 2n * 10n ** 16n, rawDown: 2n * 10n ** 16n, bank: 4n * 10n ** 16n,
    minBank: 2n * 10n ** 16n, costAllowance: ALLOWANCE,
    bookClosed: true, activated: true, strikeFixed: false, outcome: 0,
    ...over,
  }
}

const plan = (s: RoundState, now: number, memo: RoundMemo = FRESH, nowMs = 0, d: CallDeadlines = D) => planRound(s, d, memo, now, nowMs, CFG)

describe('the life of a round, as the keeper sees it', () => {
  it('owes nothing while players bet', () => {
    expect(plan(state({ bookClosed: false }), T.openAt)).toEqual({ kind: 'wait', until: T.closeAt, phase: 'collecting' })
    expect(plan(state({ bookClosed: false }), T.closeAt - 1)).toMatchObject({ kind: 'wait', phase: 'collecting' })
  })

  it('waits through the pause and the strike window, then fixes the strike at once, against the contract\'s deadline', () => {
    expect(plan(state(), T.closeAt)).toEqual({ kind: 'wait', until: T.strikeEnd, phase: 'strike-pending' })
    expect(plan(state(), T.strikeEnd)).toEqual({
      kind: 'act', action: 'fixStrike', capWei: ALLOWANCE, overdueSecs: 0, deadlineAt: D.fixStrikeBy, pastDeadline: false,
    })
    expect(plan(state(), T.strikeEnd, FRESH, 0, TIGHT)).toMatchObject({ deadlineAt: TIGHT.fixStrikeBy })
    expect(plan(state(), TIGHT.fixStrikeBy + 1, FRESH, 0, TIGHT)).toMatchObject({ kind: 'act', action: 'fixStrike', pastDeadline: true, capWei: RESERVED_CAP })
  })

  it('waits for settleAt once the strike is fixed, then settles by settleBy', () => {
    const fixed = state({ strikeFixed: true })
    expect(plan(fixed, T.strikeEnd + 1)).toEqual({ kind: 'wait', until: T.settleAt, phase: 'settle-pending' })
    expect(plan(fixed, T.settleAt)).toMatchObject({ kind: 'act', action: 'settle', deadlineAt: D.settleBy, pastDeadline: false })
    expect(plan(fixed, D.settleBy + 1)).toMatchObject({ kind: 'act', action: 'settle', pastDeadline: true })
  })

  it('settles at settleAt even if the strike was never fixed, against the earlier of the two deadlines', () => {
    // Defaults: fixStrikeBy (settleAt + 299) comes before settleBy, and is still ahead.
    expect(plan(state({ strikeFixed: false }), T.settleAt + 5)).toMatchObject({
      kind: 'act', action: 'settle', overdueSecs: 5, deadlineAt: D.fixStrikeBy, pastDeadline: false,
    })
    // Tight: the strike window is long gone by settleAt.
    expect(plan(state({ strikeFixed: false }), T.settleAt + 5, FRESH, 0, TIGHT)).toMatchObject({ deadlineAt: TIGHT.fixStrikeBy, pastDeadline: true })
  })

  it('switches to the 24 h settle at settleAt + SETTLE_GRACE: no deadline, the whole allowance', () => {
    expect(plan(state(), T.settleAt + GRACE - 1)).toMatchObject({ action: 'settle' })
    expect(plan(state(), T.settleAt + GRACE)).toEqual({
      kind: 'act', action: 'graceSettle', capWei: ALLOWANCE, overdueSecs: 0, deadlineAt: null, pastDeadline: false,
    })
  })

  it('lets go of a settled round, whoever settled it', () => {
    for (const outcome of [1, 2, 3, 4]) expect(plan(state({ outcome }), T.settleAt)).toEqual({ kind: 'drop', why: 'settled' })
  })

  it('reads a "book not closed" answer after closeAt as a lagging node, not a verdict', () => {
    expect(plan(state({ bookClosed: false, activated: false }), T.closeAt + 3)).toMatchObject({ kind: 'wait', phase: 'collecting' })
  })

  it('takes every deadline from what it is given: other times, other deadlines, nothing assumed', () => {
    const other: RoundTimes = { openAt: 1000, closeAt: 1300, strikeStart: 1360, strikeEnd: 1420, settleAt: 1720 }
    const od: CallDeadlines = { fixStrikeBy: 1500, settleBy: 1800 }
    const s = (over: Partial<RoundState> = {}) => state({ times: other, ...over })
    expect(plan(s({ activated: false }), 1300, FRESH, 0, od)).toEqual({ kind: 'drop', why: 'not-activated' })
    expect(plan(s(), 1300, FRESH, 0, od)).toEqual({ kind: 'wait', until: 1420, phase: 'strike-pending' })
    expect(plan(s(), 1420, FRESH, 0, od)).toMatchObject({ kind: 'act', action: 'fixStrike', deadlineAt: 1500 })
    expect(plan(s({ strikeFixed: true }), 1720, FRESH, 0, od)).toMatchObject({ kind: 'act', action: 'settle', deadlineAt: 1800 })
  })
})

describe('what health watches', () => {
  it('is the next owed call with its deadline, until the 24 h branch', () => {
    expect(nextDeadline(state(), D, T.closeAt, CFG)).toEqual({ action: 'fixStrike', dueAt: T.strikeEnd, deadlineAt: D.fixStrikeBy })
    expect(nextDeadline(state({ strikeFixed: true }), D, T.strikeEnd + 5, CFG)).toEqual({ action: 'settle', dueAt: T.settleAt, deadlineAt: D.settleBy })
    expect(nextDeadline(state(), D, T.settleAt, CFG)).toEqual({ action: 'settle', dueAt: T.settleAt, deadlineAt: D.fixStrikeBy })
    expect(nextDeadline(state(), D, T.settleAt + GRACE, CFG)).toBeNull()
    expect(nextDeadline(state({ activated: false }), D, T.closeAt, CFG)).toBeNull()
    expect(nextDeadline(state({ outcome: 1 }), D, T.settleAt, CFG)).toBeNull()
    expect(deadlineFor(state(), 'graceSettle', D)).toBeNull()
  })
})

/**
 * A round that did not activate has no keeper call at all: fixStrike and
 * settle both revert NotActivated, and every stake goes back through claim().
 * The project pays for nothing on it, at any time.
 */
describe('rounds that did not activate', () => {
  it('are dropped from closeAt on, whatever the clock says', () => {
    for (const now of [T.closeAt, T.strikeEnd, T.settleAt, T.settleAt + GRACE, T.settleAt + 10 * GRACE]) {
      expect(plan(state({ activated: false }), now), String(now)).toEqual({ kind: 'drop', why: 'not-activated' })
    }
  })

  it('are dropped even with money spent against them or a pause in place', () => {
    expect(plan(state({ activated: false }), T.settleAt, { spentWei: ALLOWANCE, revertStreak: 5, pausedUntilMs: 1e15 }, 0))
      .toEqual({ kind: 'drop', why: 'not-activated' })
  })
})

describe('budget and pauses in the plan', () => {
  it('gives a call inside its deadline the whole allowance, one past it allowance x (1 - reserve)', () => {
    expect(spendCap(ALLOWANCE, 'fixStrike', 2_000n, false)).toBe(ALLOWANCE)
    expect(spendCap(ALLOWANCE, 'settle', 2_000n, true)).toBe(RESERVED_CAP)
    expect(spendCap(ALLOWANCE, 'graceSettle', 2_000n, true)).toBe(ALLOWANCE)
    const fixed = state({ strikeFixed: true })
    expect(plan(fixed, T.settleAt, { ...FRESH, spentWei: RESERVED_CAP })).toMatchObject({ kind: 'act', action: 'settle' })
    expect(plan(fixed, D.settleBy + 1, { ...FRESH, spentWei: RESERVED_CAP })).toMatchObject({ kind: 'over-budget', exhausted: true })
    expect(plan(fixed, T.settleAt + GRACE, { ...FRESH, spentWei: RESERVED_CAP })).toMatchObject({ kind: 'act', action: 'graceSettle' })
  })

  it('is exhausted only when the whole allowance is spent, inside a deadline', () => {
    expect(plan(state(), T.strikeEnd, { ...FRESH, spentWei: ALLOWANCE })).toEqual({
      kind: 'over-budget', action: 'fixStrike', capWei: ALLOWANCE, overdueSecs: 0, exhausted: true, deadlineAt: D.fixStrikeBy,
    })
    expect(plan(state(), T.settleAt + GRACE, { ...FRESH, spentWei: ALLOWANCE })).toMatchObject({ kind: 'over-budget', exhausted: true })
  })

  it('uses the round\'s own allowance snapshot, not a global figure', () => {
    const small = state({ costAllowance: 2n * 10n ** 13n })
    expect(plan(small, T.strikeEnd, { ...FRESH, spentWei: 2n * 10n ** 13n })).toMatchObject({ kind: 'over-budget' })
    expect(plan(state(), T.strikeEnd, { ...FRESH, spentWei: 2n * 10n ** 13n })).toMatchObject({ kind: 'act' })
  })

  it('never pauses a call inside its deadline; pauses one past it until the pause ends', () => {
    const memo = { ...FRESH, revertStreak: 3, pausedUntilMs: 60_000 }
    expect(plan(state(), T.strikeEnd + 10, memo, 59_999, TIGHT)).toMatchObject({ kind: 'act', action: 'fixStrike' })
    expect(plan(state(), TIGHT.fixStrikeBy + 1, memo, 59_999, TIGHT)).toMatchObject({ kind: 'paused', action: 'fixStrike', untilMs: 60_000 })
    expect(plan(state(), TIGHT.fixStrikeBy + 1, memo, 60_000, TIGHT)).toMatchObject({ kind: 'act', action: 'fixStrike' })
    expect(dueAction(T, true, T.strikeEnd, GRACE)).toBeNull()
  })
})

describe('the fee an urgent call bids', () => {
  const quote = { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 10n }

  it('is the quote when there is time, double the quote when urgent', () => {
    expect(bidFor(quote, false, 100n, 10n ** 9n)).toEqual(quote)
    expect(bidFor(quote, true, 100n, 10n ** 9n)).toEqual({ maxFeePerGas: 1_000n * URGENT_FEE_MULTIPLIER, maxPriorityFeePerGas: 20n })
  })

  it('is cut to what the budget can still cover, and refused only below the quote itself', () => {
    // Room for 1 500 per gas: the doubled 2 000 does not fit, 1 500 does.
    expect(bidFor(quote, true, 100n, 150_000n)).toEqual({ maxFeePerGas: 1_500n, maxPriorityFeePerGas: 20n })
    expect(bidFor(quote, true, 100n, 100_000n)).toEqual({ maxFeePerGas: 1_000n, maxPriorityFeePerGas: 20n })
    expect(bidFor(quote, false, 100n, 99_999n)).toBeNull()
    expect(bidFor(quote, true, 100n, 0n)).toBeNull()
  })
})

describe('gas limits and worst cases', () => {
  it('never goes below the floor, follows 130% of the estimate above it', () => {
    expect(roundsGasLimit('settle', null, 0)).toBe(ROUNDS_GAS_FLOOR.settle)
    expect(roundsGasLimit('settle', 100_000n, 0)).toBe(ROUNDS_GAS_FLOOR.settle)
    // The stand-in pool on the testnet: settle measured at 0.4-0.55 M gas.
    expect(roundsGasLimit('settle', 550_000n, 0)).toBe(715_000n)
    expect(roundsGasLimit('fixStrike', 200_000n, 0)).toBe(260_000n)
    expect(roundsGasLimit('delistIfBelowGate', null, 0)).toBe(120_000n)
  })

  it('grows 1.5x per consecutive revert, at most 3x', () => {
    expect(roundsGasLimit('settle', null, 1)).toBe(390_000n)
    expect(roundsGasLimit('settle', null, 2)).toBe(585_000n)
    expect(roundsGasLimit('settle', null, 3)).toBe(780_000n)
    expect(roundsGasLimit('settle', null, 9)).toBe(780_000n)
  })

  it('bounds a transaction by limit x maxFeePerGas plus the L1 reserve, and bills receipts in full', () => {
    expect(worstCaseWei(260_000n, 2n * 10n ** 9n, 0n)).toBe(52n * 10n ** 13n)
    expect(worstCaseWei(260_000n, 2n * 10n ** 9n, 5n)).toBe(52n * 10n ** 13n + 5n)
    expect(receiptCostWei({ gasUsed: 100n, effectiveGasPrice: 3n })).toBe(300n)
    expect(receiptCostWei({ gasUsed: 100n, effectiveGasPrice: 3n, l1Fee: 7n })).toBe(307n)
  })

  it('fits the whole path, urgent bids included, in the allowance at the price it was set for', () => {
    const price = ALLOWANCE / 1_000_000n
    const worst = worstCaseWei(ROUNDS_GAS_FLOOR.fixStrike, 2n * price, 0n) + worstCaseWei(ROUNDS_GAS_FLOOR.settle, 2n * price, 0n)
    expect(worst).toBeLessThan(ALLOWANCE)
    expect(worstCaseWei(ROUNDS_GAS_FLOOR.graceSettle, (price * 3n) / 2n, 0n)).toBeLessThan(ALLOWANCE / 5n)
  })
})
