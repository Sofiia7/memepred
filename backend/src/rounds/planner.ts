/**
 * What is due on one round right now, and by when it must be done. Pure: the
 * round's state, the clock and what the keeper remembers about it go in, one
 * decision comes out. The executor in keeper.ts carries it out; health reads
 * the same decisions, so the two can never disagree about what is overdue.
 *
 * The life of a round, in the deadlines the contract reports (roundTimes; the
 * planner never computes one, see contract.ts):
 *
 *   openAt .. closeAt          players bet             keeper: nothing
 *   closeAt                    the book is final       not activated -> forget it, no paid work exists
 *   closeAt .. strikeEnd       pause, strike window    keeper: nothing
 *   strikeEnd                  fixStrike is due        keeper: fixStrike at once; hard deadline fixStrikeBy
 *   settleAt                   settle is due           keeper: settle at once; hard deadline settleBy
 *   settleAt + SETTLE_GRACE    settle -> REFUND        keeper: settle, from the reserve (budget.ts)
 *
 * (fixStrikeBy and settleBy come from keeperDeadlines(roundId): strikeEnd + 599
 * and settleAt + 839 with the defaults, settleAt + 719 for 900 s rounds.)
 *
 * fixStrike is sent right after strikeEnd, not left to settle: on a busy pool
 * the observation ring no longer holds the strike window by settleAt, so a
 * round whose strike is not fixed in time settles as REFUND. Once settleAt has
 * come, settle is sent whether or not the strike was fixed: settle reads the
 * strike window itself when it has to.
 *
 * Money is never the planner's to guess: `spentWei` is what the round has
 * really cost so far, and the cap comes from the round's own snapshot.
 */
import { Outcome, type CallDeadlines, type RoundState, type RoundTimes } from './contract.js'
import { spendCap, type RoundAction } from './budget.js'

/** What the keeper carries about a round between ticks. */
export interface RoundMemo {
  /** Wei spent on this round so far, from the store (persisted). */
  spentWei: bigint
  /** Consecutive transactions of this round that were mined and reverted. */
  revertStreak: number
  /** Wall-clock ms before which no new transaction is sent for it (after repeated reverts). */
  pausedUntilMs: number
}

export interface PlanConfig {
  /** PoolRounds.SETTLE_GRACE, seconds. */
  settleGraceSec: number
  graceReserveBps: bigint
}

export type Plan =
  /** Nothing will ever be owed on it by the keeper: stop tracking. */
  | { kind: 'drop'; why: 'settled' | 'not-activated' }
  /** Nothing to do before `until` (chain seconds). */
  | { kind: 'wait'; until: number; phase: 'collecting' | 'strike-pending' | 'settle-pending' }
  /**
   * Send `action` now; the round may spend up to `capWei` in total.
   * `deadlineAt` is the hard deadline (chain seconds), null for the 24 h settle.
   */
  | { kind: 'act'; action: RoundAction; capWei: bigint; overdueSecs: number; deadlineAt: number | null; pastDeadline: boolean }
  /** Due, but its last transactions reverted in a row: wait out the pause (only once the hard deadline has passed). */
  | { kind: 'paused'; action: RoundAction; untilMs: number; overdueSecs: number; deadlineAt: number | null }
  /**
   * Due, but not affordable. `exhausted`: the round has already spent what this
   * action may bring it up to, so no gas price will ever make it fit. Otherwise
   * the last try's worst case did not fit at the fees of the moment.
   */
  | { kind: 'over-budget'; action: RoundAction; capWei: bigint; overdueSecs: number; exhausted: boolean; deadlineAt: number | null }

/** The action due at `now`, or null while nothing is. Only for an activated, unsettled round. */
export function dueAction(times: RoundTimes, strikeFixed: boolean, now: number, settleGraceSec: number): RoundAction | null {
  if (now >= times.settleAt + settleGraceSec) return 'graceSettle'
  if (now >= times.settleAt) return 'settle'
  if (now >= times.strikeEnd && !strikeFixed) return 'fixStrike'
  return null
}

/** The deadline an action became due at. */
export function dueSince(times: RoundTimes, action: RoundAction, settleGraceSec: number): number {
  if (action === 'fixStrike') return times.strikeEnd
  if (action === 'settle') return times.settleAt
  return times.settleAt + settleGraceSec
}

/**
 * The hard deadline of an action, chain seconds; null for the 24 h settle,
 * which does not read the pool. A settle whose strike was never fixed reads
 * the strike window too, so the earlier of the two deadlines is its own.
 */
export function deadlineFor(v: RoundState, action: RoundAction, d: CallDeadlines): number | null {
  if (action === 'graceSettle') return null
  if (action === 'fixStrike') return d.fixStrikeBy
  return v.strikeFixed ? d.settleBy : Math.min(d.fixStrikeBy, d.settleBy)
}

/**
 * The call a round will owe next, and its hard deadline: what health watches.
 * Null for a round that owes nothing with a deadline (settled, not activated,
 * or already in the 24 h branch).
 */
export function nextDeadline(
  v: RoundState, d: CallDeadlines, now: number, cfg: PlanConfig,
): { action: 'fixStrike' | 'settle'; dueAt: number; deadlineAt: number } | null {
  if (v.outcome !== Outcome.NONE || !v.activated) return null
  if (now >= v.times.settleAt + cfg.settleGraceSec) return null
  const action = !v.strikeFixed && now < v.times.settleAt ? 'fixStrike' : 'settle'
  return {
    action,
    dueAt: action === 'fixStrike' ? v.times.strikeEnd : v.times.settleAt,
    deadlineAt: deadlineFor(v, action, d)!,
  }
}

/**
 * The plan for a round whose state has not been read yet: only the clock is
 * known. Before closeAt no state can make work due.
 */
export function planByClock(times: RoundTimes, now: number): Plan | null {
  if (now < times.closeAt) return { kind: 'wait', until: times.closeAt, phase: 'collecting' }
  return null
}

export function planRound(v: RoundState, d: CallDeadlines, memo: RoundMemo, now: number, nowMs: number, cfg: PlanConfig): Plan {
  if (v.outcome !== Outcome.NONE) return { kind: 'drop', why: 'settled' }

  const early = planByClock(v.times, now)
  if (early) return early
  // roundView says whether the book is closed at its own block; a read from a
  // node one block behind our clock can still say no. Not a verdict: look again.
  if (!v.bookClosed) return { kind: 'wait', until: v.times.closeAt, phase: 'collecting' }

  // The book is final from closeAt on, so "not activated" is final too. Every
  // stake in the book goes back to its player through claim(); there is no
  // keeper call for such a round, and none is paid for.
  if (!v.activated) return { kind: 'drop', why: 'not-activated' }

  const action = dueAction(v.times, v.strikeFixed, now, cfg.settleGraceSec)
  if (action === null) {
    return v.strikeFixed || now >= v.times.strikeEnd
      ? { kind: 'wait', until: v.times.settleAt, phase: 'settle-pending' }
      : { kind: 'wait', until: v.times.strikeEnd, phase: 'strike-pending' }
  }

  const overdueSecs = Math.max(0, now - dueSince(v.times, action, cfg.settleGraceSec))
  const deadlineAt = deadlineFor(v, action, d)
  const pastDeadline = deadlineAt !== null && now > deadlineAt
  const capWei = spendCap(v.costAllowance, action, cfg.graceReserveBps, pastDeadline)
  if (memo.spentWei >= capWei) return { kind: 'over-budget', action, capWei, overdueSecs, exhausted: true, deadlineAt }
  // Before a hard deadline nothing but the budget holds a call back: a pause
  // after repeated reverts would cost the round its window. The budget already
  // bounds what the reverts can burn.
  if (nowMs < memo.pausedUntilMs && (deadlineAt === null || pastDeadline)) {
    return { kind: 'paused', action, untilMs: memo.pausedUntilMs, overdueSecs, deadlineAt }
  }
  return { kind: 'act', action, capWei, overdueSecs, deadlineAt, pastDeadline }
}
