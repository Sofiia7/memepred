import { roundIdOf, roundTimes, SIDE_UP } from './roundMath'
import { TICKET_PLACED, type RoundState, type RoundsConstants } from './roundsClient'
import type { MyBet } from './useRoundsData'

/** Shared by the rounds component tests; not imported by the app. */
export const T_POOL = '0x52908400098527886E0F7030069857D2E4169EE7' as const
export const T_PLAYER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const
export const T_INDEX = 6_000_000n
/** 300 s round, 300 s pause, 300 s strike window. */
export const T_TIMES = roundTimes(300, T_INDEX, 300, 300)
export const T_ROUND_ID = roundIdOf(T_POOL, 300, T_INDEX)
export const E = 10n ** 18n
export const milli = (n: number) => (BigInt(n) * E) / 1000n

export const T_CONSTANTS: RoundsConstants = {
  weth: '0x00000000000000000000000000000000000000ee',
  minStake: milli(5),
  maxStake: milli(40),
  minBank: milli(20),
  costAllowance: 69_692_000_000_000n,
  paused: false,
  normalFeeBps: 200,
  voidFeeBps: 100,
  strikePause: 300,
  strikeWindow: 300,
  settleGrace: 86_400,
  chainSideRatio: 1,
  depthPerBank: 2500n,
  gateDepth: 50n * E,
}

export function makeRound(over: Partial<RoundState> = {}): RoundState {
  return {
    roundId: T_ROUND_ID,
    pool: T_POOL,
    duration: 300,
    index: T_INDEX,
    times: T_TIMES,
    up: milli(30),
    down: milli(20),
    acceptedUp: milli(20),
    acceptedDown: milli(20),
    minBank: milli(20),
    costAllowance: 69_692_000_000_000n,
    playFloor: milli(20),
    bookFinal: false,
    activated: false,
    outcome: 0,
    ...over,
  }
}

/** Default: 0.02 WETH on UP in a round with UP 0.03 (this bet included) and DOWN 0.02. */
export function makeBet(over: Partial<MyBet> = {}, round: Partial<RoundState> = {}): MyBet {
  return {
    roundId: T_ROUND_ID,
    round: makeRound(round),
    ticket: { stake: milli(20), side: SIDE_UP, status: TICKET_PLACED },
    ...over,
  }
}
