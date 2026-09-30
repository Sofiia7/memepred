/**
 * Everything the rounds keeper asks of the chain, behind one interface.
 *
 * keeper.ts only ever talks to RoundsChain, so the whole planning, retry and
 * budget logic runs the same against the scripted chain in keeper.test.ts, a
 * local anvil (anvil.e2e.test.ts) and the real network (index.ts). This file
 * is the only viem-shaped one, and it takes every name and type from
 * contract.ts.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import type { Fees } from '../keeper/feeEscalator.js'
import {
  DISCOVERY_EVENTS,
  POOL_EVENTS,
  POOL_ROUNDS_ABI,
  type DiscoveryEventName,
  type PoolEventName,
  type RawDeadlines,
  type RawRoundView,
  type RawTimes,
} from './contract.js'

/** A round event from getLogs; RoundSettled carries its outcome and reason. */
export interface RoundLog {
  kind?: 'round'
  eventName: DiscoveryEventName
  roundId: bigint
  blockNumber: bigint
  logIndex: number
  outcome?: number
  reason?: number
}

/** A pool event from getLogs. */
export interface PoolLog {
  kind: 'pool'
  eventName: PoolEventName
  pool: Address
  blockNumber: bigint
  logIndex: number
}

export type ContractLog = RoundLog | PoolLog

/** The writes. graceSettle is settle() called after SETTLE_GRACE, the same function. */
export type WriteCall =
  | { fn: 'fixStrike' | 'settle'; roundId: bigint }
  | { fn: 'withdrawFees' }
  | { fn: 'delistIfBelowGate'; pool: Address }

export type SimResult =
  | { ok: true; estimate: bigint | null }
  /** `error` is the contract's error name when it could be decoded (NotDue, PoolAboveGate...). */
  | { ok: false; error: string }

export type ReceiptEvent =
  | { eventName: 'StrikeFixed'; roundId: bigint }
  | { eventName: 'RoundSettled'; roundId: bigint; outcome: number; reason: number }
  | { eventName: 'FeesWithdrawn'; amount: bigint }
  | { eventName: 'PoolBelowGate'; pool: Address; depth: bigint; cardinality: bigint }

export interface RoundsReceipt {
  status: 'success' | 'reverted'
  gasUsed: bigint
  effectiveGasPrice: bigint
  /** OP-stack L1 data fee; absent on Arbitrum, where L1 is inside gasUsed. */
  l1Fee?: bigint | null
  blockNumber: bigint
  /** PoolRounds events in this receipt, decoded. */
  events: ReceiptEvent[]
}

export interface RoundsChain {
  readonly address: Address
  /** Head block and its timestamp: the clock every deadline is compared with. */
  latest(): Promise<{ number: bigint; timestamp: number }>
  /** SETTLE_GRACE (seconds): a constant of the deployment. */
  params(): Promise<{ settleGrace: number }>
  /** Round and pool events in a block range, in any order. */
  logs(fromBlock: bigint, toBlock: bigint): Promise<ContractLog[]>
  /** The round's deadlines, as the contract states them. The keeper computes none itself. */
  roundTimes(roundId: bigint): Promise<RawTimes>
  /** The hard deadlines of fixStrike and settle, as the contract states them. */
  keeperDeadlines(roundId: bigint): Promise<RawDeadlines>
  roundView(roundId: bigint): Promise<RawRoundView>
  feesAccrued(): Promise<bigint>
  /** The listing gate and a pool's depth, both in WETH wei: for health only. */
  gateDepth(): Promise<bigint>
  wethDepth(pool: Address): Promise<bigint>
  keeperBalance(): Promise<bigint | null>
  simulate(call: WriteCall): Promise<SimResult>
  send(call: WriteCall, gas: bigint, fees: Fees): Promise<Hex>
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<RoundsReceipt>
}

/**
 * A wait or a request that ran out of time. The transaction may have been
 * broadcast anyway and may still land, so a budget reservation made for it
 * stays booked (budget.ts: over-counted, never under-counted).
 */
export function isTimeout(err: unknown): boolean {
  const e = err as { name?: string; message?: string; shortMessage?: string } | null
  if (e?.name === 'WaitForTransactionReceiptTimeoutError' || e?.name === 'TimeoutError') return true
  return /timed? ?out|took too long/i.test(`${e?.shortMessage ?? ''} ${e?.message ?? ''}`)
}

/** The contract's error name for a revert, or viem's short message when there is none. */
export function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (r instanceof ContractFunctionRevertedError) {
      return r.data?.errorName ?? r.reason ?? r.shortMessage
    }
    return err.shortMessage
  }
  return String((err as Error)?.message ?? err).split('\n')[0]
}

/** The minimum of a wallet client this needs; keeperWallet.getKeeperWalletClient() fits it. */
export interface RoundsWallet {
  account: { address: Address }
  writeContract(args: any): Promise<Hex>
}

const LOG_EVENT_NAMES: readonly string[] = [...DISCOVERY_EVENTS, ...POOL_EVENTS]

export function createViemRoundsChain(args: {
  publicClient: PublicClient
  wallet: RoundsWallet
  address: Address
}): RoundsChain {
  const { publicClient, wallet, address } = args
  const account = wallet.account.address

  function callArgs(call: WriteCall) {
    if (call.fn === 'withdrawFees') return { functionName: 'withdrawFees' as const, args: [] as const }
    if (call.fn === 'delistIfBelowGate') return { functionName: 'delistIfBelowGate' as const, args: [call.pool] as const }
    return { functionName: call.fn, args: [call.roundId] as const }
  }

  let paramsCache: { settleGrace: number } | null = null

  return {
    address,

    async latest() {
      // A fresh block every time: viem otherwise serves a cached head for a few
      // seconds, and deadlines are compared against this clock.
      const b = await publicClient.getBlock({ blockTag: 'latest' })
      return { number: b.number!, timestamp: Number(b.timestamp) }
    },

    async params() {
      if (!paramsCache) {
        paramsCache = { settleGrace: Number(await publicClient.readContract({ address, abi: POOL_ROUNDS_ABI, functionName: 'SETTLE_GRACE' })) }
      }
      return paramsCache
    },

    async logs(fromBlock, toBlock) {
      const events = POOL_ROUNDS_ABI.filter((i) => i.type === 'event' && LOG_EVENT_NAMES.includes(i.name))
      const logs = await publicClient.getLogs({ address, events: events as any, fromBlock, toBlock, strict: true })
      return logs.map((l: any): ContractLog => {
        const base = { blockNumber: l.blockNumber as bigint, logIndex: Number(l.logIndex) }
        if ((POOL_EVENTS as readonly string[]).includes(l.eventName)) {
          return { kind: 'pool', eventName: l.eventName as PoolEventName, pool: l.args.pool as Address, ...base }
        }
        return {
          kind: 'round',
          eventName: l.eventName as DiscoveryEventName,
          roundId: l.args.roundId as bigint,
          ...base,
          ...(l.eventName === 'RoundSettled' ? { outcome: Number(l.args.outcome), reason: Number(l.args.reason) } : {}),
        }
      })
    },

    async roundTimes(roundId) {
      return (await publicClient.readContract({
        address, abi: POOL_ROUNDS_ABI, functionName: 'roundTimes', args: [roundId],
      })) as unknown as RawTimes
    },

    async keeperDeadlines(roundId) {
      const [fixStrikeBy, settleBy] = await publicClient.readContract({
        address, abi: POOL_ROUNDS_ABI, functionName: 'keeperDeadlines', args: [roundId],
      })
      return { fixStrikeBy, settleBy }
    },

    async roundView(roundId) {
      return (await publicClient.readContract({
        address, abi: POOL_ROUNDS_ABI, functionName: 'roundView', args: [roundId],
      })) as unknown as RawRoundView
    },

    async feesAccrued() {
      return publicClient.readContract({ address, abi: POOL_ROUNDS_ABI, functionName: 'feesAccrued' })
    },

    async gateDepth() {
      return publicClient.readContract({ address, abi: POOL_ROUNDS_ABI, functionName: 'gateDepth' })
    },

    async wethDepth(pool) {
      return publicClient.readContract({ address, abi: POOL_ROUNDS_ABI, functionName: 'wethDepth', args: [pool] })
    },

    async keeperBalance() {
      try {
        return await publicClient.getBalance({ address: account })
      } catch {
        return null
      }
    },

    async simulate(call) {
      const c = callArgs(call)
      try {
        await publicClient.simulateContract({ address, abi: POOL_ROUNDS_ABI, account, ...c } as any)
      } catch (err) {
        return { ok: false, error: revertReason(err) }
      }
      // What the node says exactly this call needs, for the limit. Best effort:
      // without it the floor in budget.ts is used.
      let estimate: bigint | null = null
      try {
        estimate = await publicClient.estimateContractGas({ address, abi: POOL_ROUNDS_ABI, account, ...c } as any)
      } catch { /* the floor stands */ }
      return { ok: true, estimate }
    },

    async send(call, gas, fees) {
      return wallet.writeContract({ address, abi: POOL_ROUNDS_ABI, ...callArgs(call), gas, ...fees })
    },

    async waitForReceipt(hash, timeoutMs) {
      const r = await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs })
      const own = r.logs.filter((l) => l.address.toLowerCase() === address.toLowerCase())
      const parsed = parseEventLogs({
        abi: POOL_ROUNDS_ABI,
        logs: own,
        eventName: ['StrikeFixed', 'RoundSettled', 'FeesWithdrawn', 'PoolBelowGate'],
      })
      const events = parsed.map((e: any): ReceiptEvent => {
        switch (e.eventName) {
          case 'RoundSettled':
            return { eventName: 'RoundSettled', roundId: e.args.roundId, outcome: Number(e.args.outcome), reason: Number(e.args.reason) }
          case 'StrikeFixed':
            return { eventName: 'StrikeFixed', roundId: e.args.roundId }
          case 'PoolBelowGate':
            return { eventName: 'PoolBelowGate', pool: e.args.pool, depth: e.args.depth, cardinality: e.args.cardinality }
          default:
            return { eventName: 'FeesWithdrawn', amount: e.args.amount }
        }
      })
      return {
        status: r.status,
        gasUsed: r.gasUsed,
        effectiveGasPrice: r.effectiveGasPrice,
        l1Fee: (r as { l1Fee?: bigint | null }).l1Fee ?? null,
        blockNumber: r.blockNumber,
        events,
      }
    },
  }
}
