import { bpsToPct, durationWords, formatMultiplier, winMultiplier } from './roundMath'

/**
 * The rules a player agrees to before signing a bet, as sentences built from
 * the contract's own numbers (fees, limits, strike pause and window) and the
 * round length.
 *
 * The first two points answer the one misunderstanding that matters most: the
 * bet is on the move from the strike to the exit, both of which are in the
 * future when the bet is placed. It is not a bet from the price on the screen.
 * The timeline (RoundTimeline) shows the same thing with clock times.
 */

/**
 * The screen describes sides matched one for one. A contract that reports any
 * other cap would make every sentence about the matched part false, so the bet
 * form refuses to sign when this and the contract's MAX_SIDE_RATIO disagree.
 */
export const SIDE_RATIO = 1

export function sideCapMismatch(chainRatio: number | undefined): boolean {
  return chainRatio !== undefined && chainRatio !== SIDE_RATIO
}

export interface RulesInput {
  feeBps: number
  voidFeeBps: number
  durationSec: number
  strikePause: number
  strikeWindow: number
  settleGraceSec: number
  /** Minimum matched bank of a round, as a display string ("0.02"). */
  minBank: string
  maxStake: string
  symbol: string
  /** K: the matched bank may be at most the pool's WETH depth / K. */
  depthPerBank: number
  /** WETH depth a pool needs to take bets at all, as a display string ("50"). */
  gateDepth: string
  /** Exit spread guard, percent (PoolOracleResolver.MAX_SPREAD_BPS). */
  spreadGuardPct: number
  testnet: boolean
  nativeEth?: boolean
}

export interface RoundRuleLine {
  id: 'what' | 'when' | 'matching' | 'payout' | 'start' | 'depth' | 'fees' | 'price' | 'collect' | 'risk'
  title: string
  text: string
}

/** Seconds from the opening of bets to the result: bets, pause, strike window, the stretch to the exit. */
export function secondsToResult(durationSec: number, strikePause: number, strikeWindow: number): number {
  return durationSec + strikePause + strikeWindow + durationSec
}

type Timing = Pick<RulesInput, 'durationSec' | 'strikePause' | 'strikeWindow'>

export function strikeAndExit(i: Timing): string {
  return (
    `The strike is the average price over ${durationWords(i.strikeWindow)} that start ` +
    `${durationWords(i.strikePause)} after bets close; the exit is read ${durationWords(i.durationSec)} after the strike ends.`
  )
}

/** The short version, shown next to the button. */
export function whatYouBetOn(i: Timing): string {
  return `You bet on the price move from the strike to the exit, not from the price now. ${strikeAndExit(i)}`
}

export function roundRules(i: RulesInput): RoundRuleLine[] {
  const fee = bpsToPct(i.feeBps)
  const voidFee = bpsToPct(i.voidFeeBps)
  const mult = formatMultiplier(winMultiplier(i.feeBps))
  const total = Math.round(secondsToResult(i.durationSec, i.strikePause, i.strikeWindow) / 60)
  const afterClose = Math.round((i.strikePause + i.strikeWindow + i.durationSec) / 60)

  return [
    {
      id: 'what',
      title: 'What you bet on',
      text:
        'Whether the pool\'s price is higher at the exit than at the strike. Both are in the future when you bet: ' +
        'the price you see now does not count, and a move that happens before the strike does not help you. ' +
        strikeAndExit(i),
    },
    {
      id: 'when',
      title: 'How long it takes',
      text:
        `Bets stay open ${durationWords(i.durationSec)}, then nothing is priced for ${durationWords(i.strikePause)}, ` +
        `the strike is averaged over ${durationWords(i.strikeWindow)}, and the exit comes ` +
        `${durationWords(i.durationSec)} later: the result is due about ${afterClose} minutes after bets close, ${total} minutes after the round opened.`,
    },
    {
      id: 'matching',
      title: 'Sides are matched 1:1',
      text:
        'Only the amount matched by the other side plays: each side plays the smaller side\'s total, shared in ' +
        'proportion to the stakes. The rest of your stake comes back without a fee. Both totals are public and change ' +
        'with every bet until the close, so the part that plays is final only then.',
    },
    {
      id: 'payout',
      title: 'Payout',
      text:
        `If your side wins you receive ${mult} of the part that plays, plus the part returned. ` +
        'If it loses you receive only the part returned.',
    },
    {
      id: 'start',
      title: 'A round may not play',
      text:
        `It plays only if both sides have bets and the matched bank reaches at least ${i.minBank} ${i.symbol}. ` +
        'Otherwise every stake is returned in full, without a fee, and can be collected as soon as bets close.',
    },
    {
      id: 'depth',
      title: "The pool's depth limits the round",
      text:
        `A round's matched bank can be at most the pool's WETH depth divided by ${i.depthPerBank}, and a pool needs ` +
        `${i.gateDepth} ${i.symbol} of depth to take bets at all. A bet that would push the bank past that is refused; ` +
        'a bet on the bigger side is never limited, its excess comes back anyway. If the pool held less liquidity during ' +
        `the strike or exit window than the bank needs, the round is refunded minus ${voidFee}.`,
    },
    {
      id: 'fees',
      title: 'Fees and gas',
      text:
        `${fee} of the matched bank when there is a winner; ${voidFee} of it on a tie or when the price cannot be ` +
        `read, and the rest comes back. Gas for ${i.nativeEth ? 'the bet and collecting' : 'the approval, the bet and collecting'} is yours.`,
    },
    {
      id: 'price',
      title: 'Where the price comes from',
      text:
        'Both prices are averages from the token\'s own liquidity pool. If the exit window moves more than ' +
        `${i.spreadGuardPct}% against its own tail, or the pool no longer holds the history, the round is refunded ` +
        `minus ${voidFee}. A thin pool can be pushed by someone willing to pay for it.`,
    },
    {
      id: 'collect',
      title: 'Collecting',
      text:
        'Nothing is sent to you automatically: press Collect after the result. If nobody settles the round within ' +
        `${Math.round(i.settleGraceSec / 3600)} hours of its settlement time, it is refunded minus ${voidFee}.`,
    },
    {
      id: 'risk',
      title: 'Risk',
      text:
        'The rounds contract has not been audited; a bug could lose the stake. ' +
        (i.testnet ? 'This is a testnet preview: use test ETH only. ' : '') +
        `Stakes are capped at ${i.maxStake} ${i.symbol} by the contract.`,
    },
  ]
}
