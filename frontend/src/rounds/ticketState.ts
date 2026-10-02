import { acceptedOf, SIDE_DOWN, SIDE_UP, type RoundSide, type RoundTimes } from './roundMath'
import {
  OUTCOME_DOWN,
  OUTCOME_NONE,
  OUTCOME_REFUND,
  OUTCOME_TIE,
  OUTCOME_UP,
  REASON_GRACE,
  REASON_HISTORY,
  REASON_SPREAD,
  REASON_THIN,
  TICKET_CLAIMED,
  TICKET_NONE,
} from './roundsClient'

/**
 * Where a player's bet in one round stands, and what they can do about it, as
 * a pure function of what the chain says. Every countdown on a row comes from
 * `deadline`; the only action a row can offer is Collect, and only when there
 * is something to collect.
 */

export interface TicketInput {
  times: RoundTimes
  now: number
  status: number
  stake: bigint
  side: number
  up: bigint
  down: bigint
  /** The round read was taken at or after closeAt. */
  bookFinal: boolean
  activated: boolean
  outcome: number
  /** previewClaim(), when it did not revert. */
  previewPayout?: bigint
  /** payout of this player's Claimed event, when one was found. */
  claimedPayout?: bigint
  /** The contract's side cap; 1 unless it says otherwise. */
  ratio?: number
}

export type TicketKind =
  | 'none'
  | 'open' // bets still open: the part that plays can still change
  | 'closing' // closed, waiting for a read of the final sums
  | 'refund' // the round did not play: the whole stake comes back
  | 'pause' // played; nothing priced until the strike starts
  | 'strike' // the entry price is being averaged
  | 'exit' // between strike and settlement
  | 'waiting-result' // due, not settled yet
  | 'claimable'
  | 'lost'
  | 'claimed'

export interface TicketView {
  kind: TicketKind
  action?: 'claim'
  /** When the current stretch ends, for a countdown. */
  deadline?: number
  side?: RoundSide
  /** The part of the stake that plays and the part returned: an estimate while open, final after. */
  accepted: bigint
  returned: bigint
  payout?: bigint
  won?: boolean
}

export function describeTicket(i: TicketInput): TicketView {
  const side = i.side === SIDE_UP || i.side === SIDE_DOWN ? (i.side as RoundSide) : undefined
  const { accepted, returned } = side ? acceptedOf(i.stake, side, i.up, i.down, i.ratio ?? 1) : { accepted: 0n, returned: i.stake }
  const base = { side, accepted, returned }
  const t = i.times

  if (i.status === TICKET_NONE) return { kind: 'none', ...base }
  if (i.status === TICKET_CLAIMED) return { kind: 'claimed', ...base, payout: i.claimedPayout }

  if (i.now < t.closeAt) return { kind: 'open', ...base, deadline: t.closeAt }
  if (!i.bookFinal) return { kind: 'closing', ...base }
  if (!i.activated) return { kind: 'refund', ...base, action: 'claim', accepted: 0n, returned: i.stake, payout: i.previewPayout ?? i.stake }

  if (i.outcome === OUTCOME_NONE) {
    if (i.now < t.strikeStart) return { kind: 'pause', ...base, deadline: t.strikeStart }
    if (i.now < t.strikeEnd) return { kind: 'strike', ...base, deadline: t.strikeEnd }
    if (i.now < t.settleAt) return { kind: 'exit', ...base, deadline: t.settleAt }
    return { kind: 'waiting-result', ...base }
  }

  const won = i.outcome === OUTCOME_UP ? side === SIDE_UP : i.outcome === OUTCOME_DOWN ? side === SIDE_DOWN : undefined
  if (i.previewPayout === undefined) return { kind: 'waiting-result', ...base, won }
  if (i.previewPayout === 0n) return { kind: 'lost', ...base, payout: 0n, won }
  return { kind: 'claimable', ...base, action: 'claim', payout: i.previewPayout, won }
}

/** Rows that need the player come first. */
export function urgency(kind: TicketKind): number {
  switch (kind) {
    case 'claimable':
    case 'refund':
      return 0
    case 'open':
      return 1
    case 'closing':
    case 'pause':
    case 'strike':
    case 'exit':
    case 'waiting-result':
      return 2
    default:
      return 3
  }
}

/**
 * Why a round that played was refunded (RoundSettled.reason), in words a
 * player can check against what they saw. Every one of these keeps the 1% fee.
 */
export function refundReasonText(reason: number | undefined, voidFeePct: string): string {
  const kept = `The ${voidFeePct} fee on the matched bank was kept; the rest comes back.`
  switch (reason) {
    case REASON_THIN:
      return (
        "The pool held too little liquidity during the strike or exit window for this round's bank, so its price there " +
        `was too cheap to move to be trusted. ${kept}`
      )
    case REASON_HISTORY:
      return `The pool's price history no longer reached back to the window, so the price could not be read. ${kept}`
    case REASON_SPREAD:
      return `The exit price moved too far within its own window to be trusted. ${kept}`
    case REASON_GRACE:
      return `Nobody settled the round within 24 hours of its settlement time. ${kept}`
    default:
      return `The price could not be used to decide the round. ${kept}`
  }
}

export function outcomeLabel(outcome: number): string {
  switch (outcome) {
    case OUTCOME_UP:
      return 'UP won'
    case OUTCOME_DOWN:
      return 'DOWN won'
    case OUTCOME_TIE:
      return 'Tie: the measured prices were equal'
    case OUTCOME_REFUND:
      return 'Refunded'
    default:
      return 'No result yet'
  }
}
