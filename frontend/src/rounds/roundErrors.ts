import { BaseError, ContractFunctionRevertedError } from 'viem'
import { isUserRejection } from '../lib/txErrors'

/**
 * Plain English for the PoolRounds custom errors a player can run into.
 * Owner-only and keeper-only errors are left out: the screen never sends those
 * calls. Names follow roundsAbi.ts; when the real ABI renames one, rename it
 * here. Anything unrecognised falls back to viem's short message.
 */
const ROUND_ERRORS: Record<string, string> = {
  NotCollecting: 'Bets on this round are closed. Nothing was taken; try the next round.',
  StakeOutOfBounds: "The stake is outside the contract's limits.",
  SelfReferral: 'Your own address cannot be your referrer.',
  AlreadyBet: 'You already have a bet in this round: one per wallet per round.',
  InvalidSide: 'The side must be UP or DOWN.',
  NoTicket: 'This wallet has no bet in that round.',
  AlreadyClaimed: 'Already collected.',
  NotSettled: 'Not ready to collect yet: bets are still open, or the round has no result.',
  PoolNotListed: 'This pool no longer takes new bets.',
  DurationNotEnabled: 'Rounds of this length no longer take new bets.',
  EnforcedPause: 'New bets are paused. Collecting still works.',
  BankTooLargeForPool:
    "The pool's depth limits this round's bank: with this stake the matched bank would be larger than the pool can " +
    'back right now. Nothing was taken; try a smaller stake, or the bigger side.',
  PoolTooThin: 'This pool holds too little WETH right now to take bets. Nothing was taken.',
  PoolAboveGate: 'This pool is still deep enough, so it stays listed.',
  ERC20InsufficientAllowance: 'The WETH approval is lower than the stake. Approve again.',
  ERC20InsufficientBalance: 'Not enough WETH for this stake. Wrap some ETH first.',
}

/** The custom error name inside a viem error, if it carries one. */
export function revertName(e: unknown): string | undefined {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError)
    const name = (reverted as ContractFunctionRevertedError | null)?.data?.errorName
    if (name) return name
  }
  const text = `${(e as { shortMessage?: string })?.shortMessage ?? ''}\n${(e as { message?: string })?.message ?? ''}`
  for (const key of Object.keys(ROUND_ERRORS)) if (new RegExp(`\\b${key}\\b`).test(text)) return key
  return undefined
}

const MAX_RAW = 240

export function explainRoundError(e: unknown, fallback = 'The transaction failed.'): string {
  if (isUserRejection(e)) return 'Cancelled in your wallet - nothing was sent.'
  const name = revertName(e)
  if (name && ROUND_ERRORS[name]) return ROUND_ERRORS[name]
  const err = e as { shortMessage?: string; message?: string } | undefined
  const raw = (err?.shortMessage || err?.message || '').trim()
  if (!raw) return fallback
  return raw.length > MAX_RAW ? `${raw.slice(0, MAX_RAW - 3)}...` : raw
}
