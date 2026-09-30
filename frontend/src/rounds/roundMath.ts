import { getAddress, toHex, type Address } from 'viem'

/**
 * Round identity, clock and money, as pure functions.
 *
 * The clock mirrors the contract so countdowns tick without a request per
 * second; the times themselves are read from roundTimes() (roundsClient) and
 * these functions only say which stretch of them "now" falls in. The money
 * functions estimate from the round's visible sums what the contract will
 * decide at the close; the contract's previewClaim() is what the screen shows
 * once there is something to collect.
 */

const U64 = (1n << 64n) - 1n
const U32 = (1n << 32n) - 1n

/** roundIdOf: pool (160 bits) | duration (32 bits) | index (64 bits). */
export function roundIdOf(pool: Address, duration: number, index: bigint | number): bigint {
  const d = BigInt(duration)
  const i = BigInt(index)
  if (d < 0n || d > U32) throw new Error('duration out of range')
  if (i < 0n || i > U64) throw new Error('index out of range')
  return (BigInt(pool) << 96n) | (d << 64n) | i
}

export function decodeRoundId(roundId: bigint): { pool: Address; duration: number; index: bigint } {
  return {
    pool: getAddress(toHex(roundId >> 96n, { size: 20 })),
    duration: Number((roundId >> 64n) & U32),
    index: roundId & U64,
  }
}

/** The window of `duration` that takes bets at `nowSec` (currentRoundId). */
export function currentIndex(nowSec: number, duration: number): bigint {
  return BigInt(Math.floor(nowSec / duration))
}

/**
 *   openAt       bets open
 *   closeAt      bets close; the book is final
 *   strikeStart  after a pause in which nothing is priced
 *   strikeEnd    the entry price is the average over [strikeStart, strikeEnd]
 *   settleAt     the exit is read at the end of [strikeEnd, settleAt]
 */
export interface RoundTimes {
  openAt: number
  closeAt: number
  strikeStart: number
  strikeEnd: number
  settleAt: number
}

/** The contract's layout, for a round the screen has not read yet (e.g. the next one). */
export function roundTimes(duration: number, index: bigint | number, strikePause: number, strikeWindow: number): RoundTimes {
  const openAt = Number(BigInt(index) * BigInt(duration))
  const closeAt = openAt + duration
  const strikeStart = closeAt + strikePause
  const strikeEnd = strikeStart + strikeWindow
  const settleAt = strikeEnd + duration
  return { openAt, closeAt, strikeStart, strikeEnd, settleAt }
}

export type RoundPhase = 'upcoming' | 'betting' | 'pause' | 'strike' | 'exit' | 'result'

/** Where `nowSec` falls. Bets are accepted while openAt <= now < closeAt, as in the contract. */
export function phaseAt(t: RoundTimes, nowSec: number): RoundPhase {
  if (nowSec < t.openAt) return 'upcoming'
  if (nowSec < t.closeAt) return 'betting'
  if (nowSec < t.strikeStart) return 'pause'
  if (nowSec < t.strikeEnd) return 'strike'
  if (nowSec < t.settleAt) return 'exit'
  return 'result'
}

// ── money ───────────────────────────────────────────────────────────────────

export const SIDE_UP = 1
export const SIDE_DOWN = 2
export type RoundSide = typeof SIDE_UP | typeof SIDE_DOWN

export function sideLabel(side: number): 'UP' | 'DOWN' | '?' {
  return side === SIDE_UP ? 'UP' : side === SIDE_DOWN ? 'DOWN' : '?'
}

/**
 * The part of a stake that plays. A side plays at most `ratio` times the other
 * side (PoolRoundMath.accepted; ratio 1 is the design: each side plays
 * min(UP, DOWN)), shared pro rata inside the side; the rest of a stake is
 * returned without a fee. Rounded down, as the contract rounds.
 *
 * `up` and `down` are the totals INCLUDING this stake.
 */
export function acceptedOf(
  stake: bigint,
  side: RoundSide,
  up: bigint,
  down: bigint,
  ratio = 1,
): { accepted: bigint; returned: bigint } {
  const sideTotal = side === SIDE_UP ? up : down
  const other = side === SIDE_UP ? down : up
  if (stake <= 0n || sideTotal <= 0n) return { accepted: 0n, returned: stake > 0n ? stake : 0n }
  const cap = BigInt(ratio) * other
  const sideAccepted = sideTotal < cap ? sideTotal : cap
  const accepted = (stake * sideAccepted) / sideTotal
  return { accepted, returned: stake - accepted }
}

/** The same, for a stake that is not placed yet: what would play if the sums stayed as they are. */
export function acceptedIfPlaced(stake: bigint, side: RoundSide, up: bigint, down: bigint, ratio = 1) {
  return acceptedOf(stake, side, side === SIDE_UP ? up + stake : up, side === SIDE_DOWN ? down + stake : down, ratio)
}

/** The accepted bank of a book: each side capped at `ratio` times the other (PoolRoundMath.accepted), summed. */
export function acceptedBank(up: bigint, down: bigint, ratio = 1): bigint {
  const r = BigInt(ratio)
  const a = up < r * down ? up : r * down
  const b = down < r * up ? down : r * up
  return a + b
}

/**
 * Whether the pool's depth lets this stake in (PoolRounds._addStake): a bet
 * that raises the accepted bank may raise it at most to `maxBank` (the pool's
 * WETH depth / depthPerBank). A bet that does not raise the bank, on the
 * bigger side, is never limited: its excess comes back anyway.
 */
export function depthAllows(up: bigint, down: bigint, side: RoundSide, stake: bigint, maxBank: bigint, ratio = 1): boolean {
  const before = acceptedBank(up, down, ratio)
  const after = acceptedBank(side === SIDE_UP ? up + stake : up, side === SIDE_DOWN ? down + stake : down, ratio)
  return after <= before || after <= maxBank
}

/**
 * The largest stake on `side`, within [0, maxStake], that the depth rule lets
 * in now. The bank only grows with the stake, so the allowed stakes are a
 * prefix of the range and a binary search finds its end.
 */
export function largestStakeWithinDepth(up: bigint, down: bigint, side: RoundSide, maxBank: bigint, maxStake: bigint, ratio = 1): bigint {
  if (depthAllows(up, down, side, maxStake, maxBank, ratio)) return maxStake
  let lo = 0n
  let hi = maxStake
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n
    if (depthAllows(up, down, side, mid, maxBank, ratio)) lo = mid
    else hi = mid - 1n
  }
  return lo
}

/**
 * The smallest accepted bank with which a round plays: at least the round's
 * minBank, and big enough that its 1% void fee, less the largest referral cut
 * (10% of it), covers twice the round's cost allowance (PoolRoundMath.isActive:
 * fees(bank, 100) and COVER = 2). Whichever is larger is what a player needs to
 * see, so the rules and the estimate show this rather than minBank alone.
 */
export function activationFloor(minBank: bigint, costAllowance: bigint): bigint {
  const need = 2n * costAllowance
  // gross = floor(bank / 100), retained = gross - floor(gross / 10): the smallest gross with retained >= need.
  let gross = (need * 10n) / 9n
  gross = gross > 10n ? gross - 10n : 0n
  while (gross - gross / 10n < need) gross += 1n
  const byCost = gross * 100n
  return byCost > minBank ? byCost : minBank
}

/** Winner's payout on the part that plays: 2 x (1 - fee). 200 bps -> 1.96x. */
export function winMultiplier(feeBps: number): number {
  return (2 * (10_000 - feeBps)) / 10_000
}

/** What a winning stake collects: the playing part times the multiplier, plus the returned part. */
export function payoutIfWin(accepted: bigint, returned: bigint, feeBps: number): bigint {
  return (accepted * 2n * BigInt(10_000 - feeBps)) / 10_000n + returned
}

/** 1.96 -> "1.96x", 1.225 -> "1.225x": at least two decimals, at most three. */
export function formatMultiplier(x: number): string {
  const three = x.toFixed(3)
  return `${three.endsWith('0') ? x.toFixed(2) : three}x`
}

/** 200 -> "2%", 150 -> "1.5%". */
export function bpsToPct(bps: number): string {
  const v = bps / 100
  return `${Number.isInteger(v) ? v.toFixed(0) : String(v)}%`
}

/** 300 -> "5m", 3600 -> "1h", 90 -> "90s". */
export function durationLabel(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

/** 300 -> "5 minutes", 90 -> "90 seconds", 60 -> "1 minute". */
export function durationWords(seconds: number): string {
  if (seconds % 60 === 0) {
    const m = seconds / 60
    return m === 1 ? '1 minute' : `${m} minutes`
  }
  return `${seconds} seconds`
}

/** Local wall time of a unix second, "14:05:30". */
export function clockTime(sec: number): string {
  const d = new Date(sec * 1000)
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Share of a stake as a whole percent, rounded down so an estimate never flatters. */
export function percentOf(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0
  return Number((part * 100n) / whole)
}
