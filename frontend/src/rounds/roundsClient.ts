import { getAbiItem, type Abi, type Address, type PublicClient } from 'viem'
import { POOL_ROUNDS_ABI } from './roundsAbi'
import { activationFloor, type RoundSide, type RoundTimes } from './roundMath'

/**
 * RoundsClient: every call the rounds screen makes to the contract, behind one
 * interface, in this one file.
 *
 * The hooks, rows, form and tests speak only this interface's own types
 * (RoundState, TicketState, ...), which carry no ABI detail; the enums below
 * are the screen's, mapped from the contract's here. So a change to the
 * contract's ABI is a change to roundsAbi.ts and to the adapter at the bottom
 * of this file, and nothing else. The adapter is written for PoolRounds
 * interface v3 (contracts/src/PoolRounds.sol): bet(roundId, stake, side,
 * referrer), roundTimes/roundView with a strike pause, maxSideRatio.
 */

// ── the screen's own vocabulary ────────────────────────────────────────────

/** Ticket status as the screen understands it (PoolRounds.TicketStatus). */
export const TICKET_NONE = 0
export const TICKET_PLACED = 1
export const TICKET_CLAIMED = 2

/** Why a settled round ended as it did (RoundSettled.reason). */
export const REASON_PRICED = 0
export const REASON_HISTORY = 1
export const REASON_SPREAD = 2
export const REASON_GRACE = 3
export const REASON_THIN = 4

/** Outcome as the screen understands it (PoolRounds.Outcome). */
export const OUTCOME_NONE = 0
export const OUTCOME_UP = 1
export const OUTCOME_DOWN = 2
export const OUTCOME_TIE = 3
export const OUTCOME_REFUND = 4

export interface RoundsConstants {
  weth: Address
  minStake: bigint
  maxStake: bigint
  /** For rounds opened from now on; a round keeps the value it opened with (RoundState). */
  minBank: bigint
  costAllowance: bigint
  paused: boolean
  normalFeeBps: number
  voidFeeBps: number
  strikePause: number
  strikeWindow: number
  settleGrace: number
  /** The contract's side cap. The screen describes 1:1 and refuses to sign under anything else. */
  chainSideRatio?: number
  /** K: a round's accepted bank may be at most the pool's WETH depth / K. */
  depthPerBank: bigint
  /** WETH depth a pool needs to be listed and to take bets (max(2 ETH, K x minBank)). */
  gateDepth: bigint
}

export interface RoundState {
  roundId: bigint
  pool: Address
  duration: number
  index: bigint
  times: RoundTimes
  /** Everything staked on each side so far. Visible to everyone. */
  up: bigint
  down: bigint
  /** The part of each side that plays. Equal with a 1:1 cap. */
  acceptedUp: bigint
  acceptedDown: bigint
  /** The round's own snapshot (taken at its first bet; the current values before one). */
  minBank: bigint
  costAllowance: bigint
  /** The smallest accepted bank with which this round plays (activationFloor). */
  playFloor: bigint
  /** The read was taken at or after closeAt, so the sums are final. */
  bookFinal: boolean
  activated: boolean
  outcome: number
  /** The strike is fixed: entryTick is the strike; exitTick is set once settled with a price. Ticks as the pool reports them. */
  strikeFixed: boolean
  entryTick: number
  exitTick: number
  /** RoundSettled.reason for a settled round, when it was looked up (REASON_*). */
  reason?: number
}

/** The pool's WETH depth now, and the largest accepted bank a round of it may reach now (maxBankOf). */
export interface PoolDepth {
  depth: bigint
  maxBank: bigint
}

export interface TicketState {
  stake: bigint
  side: number
  status: number
}

export interface MarketsScan {
  pools: { pool: Address; wethIsToken0: boolean }[]
  /** Pools that were listed and no longer take bets. */
  delisted: { pool: Address; wethIsToken0: boolean }[]
  durations: number[]
  /** The event scan failed; candidates passed in were still checked. */
  scanError?: string
}

export interface PlayerHistory {
  roundIds: bigint[]
  /** payout of each Claimed event, by round id */
  claimed: Map<string, bigint>
  scanError?: string
}

/** What wagmi's writeContract needs. */
export interface WriteRequest {
  address: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
  value?: bigint
}

export interface RoundsClient {
  readonly address: Address
  constants(): Promise<RoundsConstants>
  markets(candidatePools: Address[], candidateDurations: number[]): Promise<MarketsScan>
  round(roundId: bigint): Promise<RoundState>
  ticket(roundId: bigint, player: Address): Promise<TicketState>
  /** What claim() would pay now, or undefined while it would revert. */
  previewClaim(roundId: bigint, player: Address): Promise<bigint | undefined>
  history(player: Address): Promise<PlayerHistory>
  /** The pool's depth and maxBankOf, now. */
  poolDepth(pool: Address): Promise<PoolDepth>
  /** RoundSettled.reason of a settled round, or undefined if the event is not found. */
  settleReason(roundId: bigint): Promise<number | undefined>
  betRequest(roundId: bigint, side: RoundSide, stake: bigint, referrer: Address): WriteRequest
  betWithEthRequest(roundId: bigint, side: RoundSide, stake: bigint, referrer: Address): WriteRequest
  claimRequest(roundId: bigint): WriteRequest
  claimAsEthRequest(roundId: bigint): WriteRequest
}

// ── the adapter for PoolRounds interface v3 ─────────────────────────────────

const ABI = POOL_ROUNDS_ABI as unknown as Abi
const EV_BET = getAbiItem({ abi: POOL_ROUNDS_ABI, name: 'Bet' })
const EV_CLAIMED = getAbiItem({ abi: POOL_ROUNDS_ABI, name: 'Claimed' })
const EV_POOL_LISTED = getAbiItem({ abi: POOL_ROUNDS_ABI, name: 'PoolListed' })
const EV_DURATION_SET = getAbiItem({ abi: POOL_ROUNDS_ABI, name: 'DurationSet' })
const EV_ROUND_SETTLED = getAbiItem({ abi: POOL_ROUNDS_ABI, name: 'RoundSettled' })

interface RawTimes {
  openAt: bigint
  closeAt: bigint
  strikeStart: bigint
  strikeEnd: bigint
  settleAt: bigint
}

/** PoolRounds.RoundView */
interface RawRoundView {
  pool: Address
  duration: bigint
  index: bigint
  times: RawTimes
  committed: bigint
  rawUp: bigint
  rawDown: bigint
  acceptedUp: bigint
  acceptedDown: bigint
  bank: bigint
  minBank: bigint
  costAllowance: bigint
  bookClosed: boolean
  activated: boolean
  strikeFixed: boolean
  outcome: number
  entryTick: number
  exitTick: number
}

export function toTimes(t: RawTimes): RoundTimes {
  return {
    openAt: Number(t.openAt),
    closeAt: Number(t.closeAt),
    strikeStart: Number(t.strikeStart),
    strikeEnd: Number(t.strikeEnd),
    settleAt: Number(t.settleAt),
  }
}

export function createRoundsClient(client: PublicClient, address: Address, fromBlock: bigint): RoundsClient {
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi: ABI, functionName, args }) as Promise<T>

  return {
    address,

    async constants() {
      const [weth, minStake, maxStake, minBank, costAllowance, paused, normal, voidFee, pause, window, grace, ratio, depthPerBank, gateDepth] = await Promise.all([
        read<Address>('weth'),
        read<bigint>('minStake'),
        read<bigint>('maxStake'),
        read<bigint>('minBank'),
        read<bigint>('costAllowance'),
        read<boolean>('paused'),
        read<bigint>('NORMAL_FEE_BPS'),
        read<bigint>('VOID_FEE_BPS'),
        read<bigint>('strikePause'),
        read<bigint>('strikeWindow'),
        read<bigint>('SETTLE_GRACE'),
        read<bigint>('maxSideRatio'),
        read<bigint>('depthPerBank'),
        read<bigint>('gateDepth'),
      ])
      return {
        weth,
        minStake,
        maxStake,
        minBank,
        costAllowance,
        paused,
        normalFeeBps: Number(normal),
        voidFeeBps: Number(voidFee),
        strikePause: Number(pause),
        strikeWindow: Number(window),
        settleGrace: Number(grace),
        chainSideRatio: Number(ratio),
        depthPerBank,
        gateDepth,
      }
    },

    async markets(candidatePools, candidateDurations) {
      const pools = new Map<string, Address>(candidatePools.map((p) => [p.toLowerCase(), p]))
      const durations = new Set<number>(candidateDurations)
      let scanError: string | undefined
      try {
        const logs = await client.getLogs({ address, events: [EV_POOL_LISTED, EV_DURATION_SET], fromBlock, toBlock: 'latest' })
        for (const log of logs as unknown as { eventName: string; args: Record<string, unknown> }[]) {
          if (log.eventName === 'PoolListed') pools.set(String(log.args.pool).toLowerCase(), log.args.pool as Address)
          if (log.eventName === 'DurationSet') durations.add(Number(log.args.duration as bigint))
        }
      } catch (e: any) {
        scanError = e?.shortMessage || e?.message || 'log scan failed'
      }
      const configs = await Promise.all(
        [...pools.values()].map(async (pool) => {
          try {
            const [on, wethIsToken0] = await read<readonly [boolean, boolean]>('pools', [pool])
            return { pool, wethIsToken0, on }
          } catch {
            return undefined
          }
        }),
      )
      const listed = configs.map((c) => (c?.on ? { pool: c.pool, wethIsToken0: c.wethIsToken0 } : undefined))
      // Seen listed once (PoolListed) and delisted since (delistPool, delistIfBelowGate): no new
      // bets, but bets already in its rounds run to the end and are collected as usual.
      const delisted = configs
        .filter((c): c is { pool: Address; wethIsToken0: boolean; on: boolean } => !!c && !c.on)
        .map((c) => ({ pool: c.pool, wethIsToken0: c.wethIsToken0 }))
      const enabled = await Promise.all(
        [...durations].map(async (d) => {
          try {
            return (await read<boolean>('durationEnabled', [BigInt(d)])) ? d : undefined
          } catch {
            return undefined
          }
        }),
      )
      return {
        pools: listed.filter((p): p is { pool: Address; wethIsToken0: boolean } => !!p),
        delisted,
        durations: enabled.filter((d): d is number => d !== undefined).sort((a, b) => a - b),
        scanError,
      }
    },

    async round(roundId) {
      const [times, v] = await Promise.all([read<RawTimes>('roundTimes', [roundId]), read<RawRoundView>('roundView', [roundId])])
      return {
        roundId,
        pool: v.pool,
        duration: Number(v.duration),
        index: v.index,
        times: toTimes(times),
        up: v.rawUp,
        down: v.rawDown,
        acceptedUp: v.acceptedUp,
        acceptedDown: v.acceptedDown,
        minBank: v.minBank,
        costAllowance: v.costAllowance,
        playFloor: activationFloor(v.minBank, v.costAllowance),
        bookFinal: v.bookClosed,
        activated: v.activated,
        outcome: Number(v.outcome),
        strikeFixed: v.strikeFixed,
        entryTick: Number(v.entryTick),
        exitTick: Number(v.exitTick),
      }
    },

    async ticket(roundId, player) {
      const [stake, side, status] = await read<readonly [bigint, number, number]>('ticketOf', [roundId, player])
      return { stake, side: Number(side), status: Number(status) }
    },

    async previewClaim(roundId, player) {
      try {
        const [payout] = await read<readonly [bigint, bigint]>('previewClaim', [roundId, player])
        return payout
      } catch {
        return undefined
      }
    },

    async history(player) {
      try {
        const [bets, claims] = await Promise.all([
          client.getLogs({ address, event: EV_BET, args: { player }, fromBlock, toBlock: 'latest' }),
          client.getLogs({ address, event: EV_CLAIMED, args: { player }, fromBlock, toBlock: 'latest' }),
        ])
        const ids = new Map<string, bigint>()
        for (const l of bets) if (l.args.roundId !== undefined) ids.set(l.args.roundId.toString(), l.args.roundId)
        const claimed = new Map<string, bigint>()
        for (const l of claims) {
          if (l.args.roundId !== undefined && l.args.payout !== undefined) claimed.set(l.args.roundId.toString(), l.args.payout)
        }
        return { roundIds: [...ids.values()], claimed }
      } catch (e: any) {
        return { roundIds: [], claimed: new Map(), scanError: e?.shortMessage || e?.message || 'log scan failed' }
      }
    },

    async poolDepth(pool) {
      const [depth, maxBank] = await Promise.all([read<bigint>('wethDepth', [pool]), read<bigint>('maxBankOf', [pool])])
      return { depth, maxBank }
    },

    async settleReason(roundId) {
      try {
        const logs = await client.getLogs({ address, event: EV_ROUND_SETTLED, args: { roundId }, fromBlock, toBlock: 'latest' })
        const last = logs[logs.length - 1]
        return last?.args.reason === undefined ? undefined : Number(last.args.reason)
      } catch {
        return undefined
      }
    },

    betRequest(roundId, side, stake, referrer) {
      // PoolRounds.bet(uint256 roundId, uint256 stake, Side side, address referrer)
      return { address, abi: ABI, functionName: 'bet', args: [roundId, stake, side, referrer] }
    },

    betWithEthRequest(roundId, side, stake, referrer) {
      return { address, abi: ABI, functionName: 'betWithEth', args: [roundId, side, referrer], value: stake }
    },

    claimRequest(roundId) {
      return { address, abi: ABI, functionName: 'claim', args: [roundId] }
    },

    claimAsEthRequest(roundId) {
      return { address, abi: ABI, functionName: 'claimAsEth', args: [roundId] }
    },
  }
}
