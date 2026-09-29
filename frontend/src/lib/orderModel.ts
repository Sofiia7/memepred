/**
 * Pure order-state logic: what an order is, what its viewer may do with it, and
 * what is left to wait for.
 *
 * The order page, the status card and the portfolio all used to derive these
 * from a single enum and the order's FIRST match, which is how a won match hid
 * behind a tied one, Recover got aimed at a match that had settled a day ago
 * and Claim was offered to whoever opened a shared link (audit A04, U08 and the
 * 2026-09-28 follow-up). Everything here is a function of plain values, so each
 * of those cases is a unit test rather than a screenshot.
 *
 * Deliberately free of wagmi, viem and React: the money rules are copied from
 * OrderbookMarket.sol next to the require() chains they mirror, and they should
 * be checkable without a rendering library.
 */
import { MATCH_TIMEOUT_SEC, SETTLE_GRACE_SEC } from './orderTiming'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** OrderbookMarket.OrderStatus, by ordinal. */
export const ORDER_STATUS = {
  PENDING: 0,
  MATCHED: 1,
  SETTLED: 2,
  CLAIMED: 3,
  REFUNDED: 4,
} as const

/** The fields of getOrder() the rules below read. */
export interface OrderLike {
  trader: string
  amount: bigint
  filledAmount: bigint
  status: number
  placedAt: bigint
  pendingSettlements: bigint
  payout: bigint
  unmatchedRefunded: boolean
}

// ── Identity ────────────────────────────────────────────────

/** getOrder() of an id nobody ever used is a zeroed struct, not a revert. */
export function orderExists(o: Pick<OrderLike, 'trader'>): boolean {
  return o.trader.toLowerCase() !== ZERO_ADDRESS
}

export function sameAddress(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

/** claim() and cancelOrder() both require msg.sender to be the order's trader. */
export function isOrderTrader(o: Pick<OrderLike, 'trader'>, viewer?: string | null): boolean {
  return orderExists(o) && sameAddress(o.trader, viewer)
}

// ── Remainder, cancel, refund ───────────────────────────────

const isOpenStatus = (status: number) =>
  status === ORDER_STATUS.PENDING || status === ORDER_STATUS.MATCHED

/**
 * The part of the stake that was never matched and has not been returned yet.
 * Zero once refundExpired, cancelOrder or the dust rule in _tryMatch has given
 * it back (`unmatchedRefunded`), whatever the amounts still say.
 */
export function unmatchedRemainder(
  o: Pick<OrderLike, 'amount' | 'filledAmount' | 'unmatchedRefunded'>,
): bigint {
  if (o.unmatchedRefunded) return 0n
  return o.amount > o.filledAmount ? o.amount - o.filledAmount : 0n
}

/**
 * cancelOrder(): trader only, at any time, while the order is PENDING or MATCHED
 * and still has an unmatched remainder. Its reverts are "not your order",
 * "already refunded", "wrong status" and "nothing to refund" (fully filled).
 */
export function canCancelRemainder(o: OrderLike, viewer?: string | null): boolean {
  return isOrderTrader(o, viewer) && isOpenStatus(o.status) && unmatchedRemainder(o) > 0n
}

/** Seconds until the 5-minute match window closes; 0 once it has. */
export function matchWindowLeft(o: Pick<OrderLike, 'placedAt'>, nowSec: number): number {
  return Math.max(0, Number(o.placedAt) + MATCH_TIMEOUT_SEC - nowSec)
}

/**
 * refundExpired(): permissionless, but only past MATCH_TIMEOUT and only while
 * something is still unmatched. `>` and not `>=`, exactly like the contract's
 * `block.timestamp > o.placedAt + MATCH_TIMEOUT`, so the button never shows up
 * one second before the call would succeed.
 */
export function canRefundExpired(o: OrderLike, nowSec: number): boolean {
  return (
    isOpenStatus(o.status) &&
    unmatchedRemainder(o) > 0n &&
    nowSec > Number(o.placedAt) + MATCH_TIMEOUT_SEC
  )
}

// ── Claim ───────────────────────────────────────────────────

/**
 * Mirrors OrderbookMarket.claim()'s require chain, minus the msg.sender check
 * (see isOrderTrader). Audit A04: a REFUNDED order that also won a match can
 * satisfy it, which is why this looks at the fields and not at one enum.
 */
export function claimableNow(o: OrderLike): boolean {
  return (
    o.pendingSettlements === 0n &&
    o.status !== ORDER_STATUS.CLAIMED &&
    o.payout > 0n &&
    (o.status === ORDER_STATUS.SETTLED ||
      (o.filledAmount > 0n && (o.filledAmount === o.amount || o.unmatchedRefunded)))
  )
}

export type ClaimBlocker =
  | 'none'            // claimable right now
  | 'claimed'         // already paid out
  | 'no-payout'       // nothing accrued (yet)
  | 'matches-running' // a match on this order has not settled
  | 'open-remainder'  // every match settled, but part of the stake is still waiting

/**
 * Why Claim is not available, for an order that has (or may have) winnings.
 * 'open-remainder' is the surprising one: a partly filled order whose filled
 * part already won cannot be claimed while its unmatched tail is still open, so
 * the card has to say what to do about it (cancel the tail, or wait for the
 * automatic refund).
 */
export function claimBlocker(o: OrderLike): ClaimBlocker {
  if (o.status === ORDER_STATUS.CLAIMED) return 'claimed'
  if (o.payout <= 0n) return 'no-payout'
  if (claimableNow(o)) return 'none'
  if (o.pendingSettlements > 0n) return 'matches-running'
  return 'open-remainder'
}

// ── Phase ───────────────────────────────────────────────────

export type OrderPhase =
  | 'searching' // nothing matched yet, the whole stake is waiting
  | 'partial'   // some matched, the rest is still waiting in the book
  | 'running'   // fully matched (or the tail was returned), settlements pending
  | 'settled'
  | 'claimed'
  | 'refunded'

/**
 * The lifecycle stage, from the fields rather than from the enum alone: the
 * contract leaves a partly filled order PENDING until its tail is gone, so
 * "status is PENDING" means both "nobody wants the other side" and "half of it
 * is already running" and the card used to call both "searching for a match".
 */
export function orderPhase(o: OrderLike): OrderPhase {
  if (o.status === ORDER_STATUS.REFUNDED) return 'refunded'
  if (o.status === ORDER_STATUS.CLAIMED) return 'claimed'
  if (o.status === ORDER_STATUS.SETTLED) return 'settled'
  if (o.filledAmount === 0n) return 'searching'
  return unmatchedRemainder(o) > 0n ? 'partial' : 'running'
}

// ── Matches and settlement timing ───────────────────────────

/** What the backend's per-match breakdown calls a match's result. */
export type MatchOutcome = 'pending' | 'won' | 'lost' | 'tied' | 'emergency_refunded'

export interface MatchTiming {
  matchId: string
  settled: boolean
  settleAt: number
}

/**
 * Which of an order's matches is actually stuck past SETTLE_GRACE, if any.
 * The first unsettled one that is, not the order's first match: audit A04's
 * Recover button was always aimed at order.matchId, even once that match had
 * settled and a LATER one was the overdue one.
 */
export function findStuckMatchId(matches: MatchTiming[], nowUnixSec: number): bigint | undefined {
  const stuck = matches.find((m) => !m.settled && nowUnixSec > m.settleAt + SETTLE_GRACE_SEC)
  return stuck ? BigInt(stuck.matchId) : undefined
}

/**
 * The backend's per-match list, corrected by the chain for the one match the
 * chain tells us about for free (getMatch(order.matchId)).
 *
 * The chain wins for that match: an indexer that is a few blocks behind must
 * not keep Recover alive for a match that has already settled. When the list is
 * empty (not loaded, backend down, or an order with no indexed matches) that
 * match becomes the whole list, which is the single-match fallback and nothing
 * more. A settled match is never a Recover candidate either way.
 */
export function mergeMatchTiming<T extends MatchTiming>(
  apiMatches: T[],
  first?: { matchId: bigint; settled: boolean; settleAt: bigint | number } | null,
): (T | MatchTiming)[] {
  if (!first || first.matchId <= 0n) return apiMatches
  const id = first.matchId.toString()
  const fromChain: MatchTiming = { matchId: id, settled: first.settled, settleAt: Number(first.settleAt) }
  const out: (T | MatchTiming)[] = apiMatches.map((m) =>
    m.matchId === id ? { ...m, settled: fromChain.settled, settleAt: fromChain.settleAt } : m,
  )
  if (!apiMatches.some((m) => m.matchId === id)) out.push(fromChain)
  return out.sort((a, b) => a.settleAt - b.settleAt)
}

export type SettlementStatus =
  | { kind: 'none' }
  | { kind: 'countdown'; matchId: string; settleAt: number; secondsLeft: number; openCount: number }
  | { kind: 'overdue'; matchId: string; settleAt: number; overdueBy: number; recoverInSec: number; openCount: number }
  | { kind: 'recoverable'; matchId: string; settleAt: number; overdueBy: number; openCount: number }

/**
 * Where the unsettled matches stand against the two deadlines that matter:
 * settleAt (the resolver settles or refunds the match from here on) and
 * settleAt + SETTLE_GRACE (past it anyone can call emergencyRefundMatch).
 *
 * Reports the most urgent situation first: a match that can already be
 * recovered, else the earliest one that is due, else the next one to come due.
 */
export function settlementStatus(matches: MatchTiming[], now: number): SettlementStatus {
  const open = matches.filter((m) => !m.settled)
  if (open.length === 0) return { kind: 'none' }

  const stuckId = findStuckMatchId(open, now)
  if (stuckId !== undefined) {
    const m = open.find((x) => x.matchId === stuckId.toString())!
    return {
      kind: 'recoverable',
      matchId: m.matchId,
      settleAt: m.settleAt,
      overdueBy: now - m.settleAt,
      openCount: open.length,
    }
  }

  const next = [...open].sort((a, b) => a.settleAt - b.settleAt)[0]
  if (now >= next.settleAt) {
    return {
      kind: 'overdue',
      matchId: next.matchId,
      settleAt: next.settleAt,
      overdueBy: now - next.settleAt,
      // Until the grace is over. emergencyRefundMatch needs block.timestamp
      // STRICTLY past it, which findStuckMatchId (`>`) already honours: the
      // Recover button appears one second after this reaches zero.
      recoverInSec: Math.max(0, next.settleAt + SETTLE_GRACE_SEC - now),
      openCount: open.length,
    }
  }
  return {
    kind: 'countdown',
    matchId: next.matchId,
    settleAt: next.settleAt,
    secondsLeft: next.settleAt - now,
    openCount: open.length,
  }
}

/** mm:ss, or h:mm:ss from one hour up. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = m.toString().padStart(2, '0')
  const ss = sec.toString().padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** hh:mm, rounded UP so a countdown never reads 00:00 while seconds remain. */
export function formatHoursMinutes(totalSeconds: number): string {
  const minutes = Math.max(0, Math.ceil(totalSeconds / 60))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
}

export interface SettlementMessage {
  headline: string
  /** What the keeper is actually doing, when the wait is longer than usual. */
  note?: string
  /** The "when can I recover my stake" line, only while that is still ahead. */
  recover?: string
}

/** The words for a SettlementStatus. Null when there is nothing left to wait for. */
export function settlementMessage(s: SettlementStatus): SettlementMessage | null {
  switch (s.kind) {
    case 'none':
      return null
    case 'countdown':
      return {
        headline:
          `Result in ${formatCountdown(s.secondsLeft)}` +
          (s.openCount > 1 ? ` (next of ${s.openCount} matches)` : ''),
      }
    case 'overdue':
      return {
        headline:
          'Waiting for the keeper to post the result' +
          (s.overdueBy >= 60 ? ` (overdue ${formatCountdown(s.overdueBy)})` : ''),
        // Since the resolver refunds what it cannot price right after settleAt,
        // "the result" can be a refund, and the wait says so.
        note: 'The keeper settles the match, or refunds both stakes if the price cannot be determined.',
        recover: `Recover available in ${formatHoursMinutes(s.recoverInSec)}`,
      }
    case 'recoverable':
      return {
        headline: 'Settlement is more than 24 hours overdue - the keeper never resolved this match.',
      }
  }
}

// ── Outcomes ────────────────────────────────────────────────

export type OrderOutcome = 'open' | 'win' | 'loss' | 'tie' | 'refunded' | 'mixed'

/**
 * One label for a whole order from its per-match results. Any match still
 * running makes it 'open'; identical results keep their name; anything else is
 * 'mixed'. The old UI called an order "won" as soon as one of its matches was.
 */
export function aggregateOutcome(outcomes: MatchOutcome[]): OrderOutcome {
  if (outcomes.length === 0) return 'open'
  if (outcomes.includes('pending')) return 'open'
  const first = outcomes[0]
  if (!outcomes.every((o) => o === first)) return 'mixed'
  switch (first) {
    case 'won':
      return 'win'
    case 'lost':
      return 'loss'
    case 'tied':
      return 'tie'
    default:
      return 'refunded'
  }
}

export const MATCH_OUTCOME_LABEL: Record<MatchOutcome, string> = {
  pending: 'awaiting settlement',
  won: 'won',
  lost: 'lost',
  tied: 'tied - refunded',
  // The API's emergency_refunded also covers the resolver's immediate refund of
  // a match it could not price, not only the 24-hour backstop.
  emergency_refunded: 'refunded (no price available)',
}

/** The one-line reason behind a refunded match, for cards that show only that. */
export const REFUND_EXPLANATION =
  'The price could not be determined for this window, so both sides got their stake back with no fee.'

// ── Money ───────────────────────────────────────────────────

/**
 * A JSON number (the backend serves NUMERIC as parseFloat) back to base units.
 * Rounds through toFixed first: 0.019600000000000002 is what the float holds,
 * and parseUnits-style code would carry those digits into the amount. Twelve
 * places is far below anything the UI shows and above what a double can carry.
 */
export function numberToUnits(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n
  const places = Math.min(decimals, 12)
  const [whole, frac = ''] = value.toFixed(places).split('.')
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals)
  return BigInt(whole + padded)
}
