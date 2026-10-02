import { isAddress, type Address } from 'viem'
import { decodeRoundId, SIDE_DOWN, SIDE_UP, type RoundSide } from './roundMath'

/**
 * A challenge: "I bet DOWN on FROGGO, take UP against me". The link opens the
 * same round with the other side preselected and the challenger as referrer,
 * so a bettor brings their own counterparty and earns the referral share of
 * the fee on it (the registry link is set by the friend's first bet).
 *
 *   /rounds?round=<roundId>&take=up|down&ref=<challenger>
 *
 * `take` is the side offered to the friend, never the challenger's own side,
 * so the link reads the same way in the URL and on the screen.
 */
export interface Challenge {
  roundId: bigint
  pool: Address
  duration: number
  index: bigint
  /** The side the friend is asked to take. */
  take: RoundSide
  /** The challenger, as referrer; absent when the link carries none. */
  ref?: Address
}

export const otherSide = (side: RoundSide): RoundSide => (side === SIDE_UP ? SIDE_DOWN : SIDE_UP)
const sideWord = (side: RoundSide) => (side === SIDE_UP ? 'UP' : 'DOWN')

export function challengeUrl(origin: string, roundId: bigint, mySide: RoundSide, me?: Address): string {
  const q = new URLSearchParams({ round: roundId.toString(), take: sideWord(otherSide(mySide)).toLowerCase() })
  if (me) q.set('ref', me)
  return `${origin.replace(/\/$/, '')}/rounds?${q.toString()}`
}

export function parseChallenge(search: string): Challenge | null {
  const q = new URLSearchParams(search)
  const round = q.get('round')
  const take = (q.get('take') ?? '').toLowerCase()
  if (!round || !/^\d+$/.test(round) || (take !== 'up' && take !== 'down')) return null
  let roundId: bigint
  try {
    roundId = BigInt(round)
  } catch {
    return null
  }
  const { pool, duration, index } = decodeRoundId(roundId)
  if (duration <= 0) return null
  const ref = q.get('ref')
  return { roundId, pool, duration, index, take: take === 'up' ? SIDE_UP : SIDE_DOWN, ref: ref && isAddress(ref) ? ref : undefined }
}

export interface ChallengeTextInput {
  symbol: string
  mySide: RoundSide
  /** The stake as shown on screen, "0.005 ETH". */
  stake: string
  /** Minutes until bets close, already rounded; 0 or less means "about to close". */
  minutesLeft: number
  network: string
}

/** The message a challenger posts; the link follows it. */
export function challengeText(i: ChallengeTextInput): string {
  const closes = i.minutesLeft > 0 ? `Bets close in ${i.minutesLeft} min.` : 'Bets close any moment.'
  return `I just bet ${sideWord(i.mySide)} ${i.stake} on ${i.symbol} on FlipTheMeme (${i.network}). ${closes} Think it goes ${sideWord(otherSide(i.mySide))}? Take the other side:`
}

export const shareLinks = (text: string, url: string) => ({
  x: `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
  telegram: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
  farcaster: `https://warpcast.com/~/compose?text=${encodeURIComponent(text)}&embeds[]=${encodeURIComponent(url)}`,
})
