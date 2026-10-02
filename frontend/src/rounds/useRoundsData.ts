import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import type { Address, PublicClient } from 'viem'
import { TARGET_CHAIN_ID } from '../lib/chain'
import { usePools } from '../hooks/usePools'
import { shortAddr } from '../lib/symbols'
import { ROUNDS_CONFIG } from './roundsAbi'
import { PREVIOUS_ROUNDS } from './legacyRounds'
import { createRoundsClient, OUTCOME_REFUND, TICKET_NONE, TICKET_PLACED, type PoolDepth, type RoundsClient, type RoundState, type TicketState } from './roundsClient'
import { currentIndex, decodeRoundId, roundIdOf } from './roundMath'

/**
 * Everything the rounds screen reads, straight from the chain, through
 * RoundsClient. No new backend: pools come from the contract's PoolListed
 * events (and the existing pool feed, when it answers, for names), a player's
 * bets from their Bet events, and every number from view calls. All of it
 * lives under the react-query key ['rounds', ...], so a finished transaction
 * refreshes the screen with one invalidateQueries.
 */

export function useRoundsClient(): RoundsClient | undefined {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID }) as PublicClient | undefined
  return useMemo(
    () => (client && ROUNDS_CONFIG.address ? createRoundsClient(client, ROUNDS_CONFIG.address, ROUNDS_CONFIG.deployBlock) : undefined),
    [client],
  )
}

export function useRoundsConstants() {
  const rounds = useRoundsClient()
  return useQuery({
    queryKey: ['rounds', 'constants', rounds?.address],
    enabled: !!rounds,
    refetchInterval: 30_000,
    queryFn: () => (rounds as RoundsClient).constants(),
  })
}

// ── pools ───────────────────────────────────────────────────────────────────

const POOL_ABI = [
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const
const SYMBOL_ABI = [{ type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }] as const

export interface RoundPool {
  pool: Address
  symbol: string
  /** Which side of the pair is WETH: UP means the coin dearer in WETH, a lower tick when WETH is token0. */
  wethIsToken0?: boolean
}

export interface RoundMarkets {
  pools: RoundPool[]
  /** Delisted pools, for naming bets already in them; no new bets there. */
  delisted: RoundPool[]
  durations: number[]
  scanError?: string
}

/** The memecoin's symbol, read from the pool's other token. Falls back to the pool address. */
async function tokenSymbol(client: PublicClient, pool: Address, wethIsToken0: boolean): Promise<string> {
  try {
    const token = (await client.readContract({ address: pool, abi: POOL_ABI, functionName: wethIsToken0 ? 'token1' : 'token0' })) as Address
    const sym = (await client.readContract({ address: token, abi: SYMBOL_ABI, functionName: 'symbol' })) as string
    return sym.trim().slice(0, 16) || shortAddr(pool)
  } catch {
    return shortAddr(pool)
  }
}

export function useRoundMarkets() {
  const rounds = useRoundsClient()
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID }) as PublicClient | undefined
  // The pool feed the Pools screen uses: optional here. It names tokens; the
  // contract decides which pools take bets, so a feed that is down costs names only.
  const feed = usePools()
  const feedPools = feed.data?.pools
  const feedKey = (feedPools ?? []).map((p) => p.pool.toLowerCase()).sort().join(',')

  return useQuery<RoundMarkets>({
    queryKey: ['rounds', 'markets', rounds?.address, feedKey],
    enabled: !!rounds && !!client,
    refetchInterval: 60_000,
    queryFn: async () => {
      const names = new Map((feedPools ?? []).filter((p) => p.symbol).map((p) => [p.pool.toLowerCase(), p.symbol as string]))
      const scan = await (rounds as RoundsClient).markets(
        (feedPools ?? []).map((p) => p.pool as Address),
        ROUNDS_CONFIG.durations,
      )
      const pools = await Promise.all(
        scan.pools.map(async (p) => ({
          pool: p.pool,
          wethIsToken0: p.wethIsToken0,
          symbol: names.get(p.pool.toLowerCase()) ?? (await tokenSymbol(client as PublicClient, p.pool, p.wethIsToken0)),
        })),
      )
      pools.sort((a, b) => a.symbol.localeCompare(b.symbol))
      const delisted = await Promise.all(
        scan.delisted.map(async (p) => ({
          pool: p.pool,
          wethIsToken0: p.wethIsToken0,
          symbol: names.get(p.pool.toLowerCase()) ?? (await tokenSymbol(client as PublicClient, p.pool, p.wethIsToken0)),
        })),
      )
      return { pools, delisted, durations: scan.durations, scanError: scan.scanError }
    },
  })
}

/**
 * A pool's WETH depth and the largest bank a round of it may reach now. Depth
 * moves with the pool, so this is read often; bets that would raise a bank past
 * it are refused by the contract (BankTooLargeForPool), and a pool below the
 * gate takes no bets at all (PoolTooThin).
 */
export function usePoolDepth(pool: Address | undefined) {
  const rounds = useRoundsClient()
  return useQuery<PoolDepth>({
    queryKey: ['rounds', 'depth', rounds?.address, pool?.toLowerCase()],
    enabled: !!rounds && !!pool,
    refetchInterval: 10_000,
    queryFn: () => (rounds as RoundsClient).poolDepth(pool as Address),
  })
}

// ── rounds ──────────────────────────────────────────────────────────────────

/** The round taking bets right now for every (pool, duration), by the chain clock. */
export function useCurrentRounds(markets: RoundMarkets | undefined, nowSec: number) {
  const rounds = useRoundsClient()
  const ids = useMemo(() => {
    const out: bigint[] = []
    for (const p of markets?.pools ?? []) for (const d of markets?.durations ?? []) out.push(roundIdOf(p.pool, d, currentIndex(nowSec, d)))
    return out
  }, [markets, nowSec])
  const key = ids.map(String).join(',')

  return useQuery<Map<string, RoundState>>({
    queryKey: ['rounds', 'current', rounds?.address, key],
    enabled: !!rounds && ids.length > 0,
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
    queryFn: async () => new Map(await Promise.all(ids.map(async (id) => [id.toString(), await (rounds as RoundsClient).round(id)] as const))),
  })
}

// ── the connected player's bets ─────────────────────────────────────────────

export interface MyBet {
  contract: Address
  roundId: bigint
  round: RoundState
  ticket: TicketState
  previewPayout?: bigint
  claimedPayout?: bigint
}

export interface MyBets {
  bets: MyBet[]
  /** The Bet/Claimed log scan failed. */
  scanError?: string
}

export function useMyBets(player: Address | undefined) {
  const rounds = useRoundsClient()
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID }) as PublicClient | undefined
  return useQuery<MyBets>({
    queryKey: ['rounds', 'mine', rounds?.address, player?.toLowerCase()],
    enabled: !!rounds && !!client && !!player,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const who = player as Address
      const current = rounds as RoundsClient
      const previous = createRoundsClient(client as PublicClient, PREVIOUS_ROUNDS.address, PREVIOUS_ROUNDS.deployBlock)
      const errors: string[] = []
      const groups = await Promise.all([current, previous].map(async (c) => {
        try {
          const history = await c.history(who)
          if (history.scanError) errors.push(`${c.address}: ${history.scanError}`)
          const bets = await Promise.all(history.roundIds.map(async (roundId): Promise<MyBet | undefined> => {
            try {
              const [ticket, round] = await Promise.all([c.ticket(roundId, who), c.round(roundId)])
              if (ticket.status === TICKET_NONE) return undefined
              if (round.outcome === OUTCOME_REFUND) round.reason = await c.settleReason(roundId)
              const previewPayout = ticket.status === TICKET_PLACED && round.bookFinal ? await c.previewClaim(roundId, who) : undefined
              return { contract: c.address, roundId, round, ticket, previewPayout, claimedPayout: history.claimed.get(roundId.toString()) }
            } catch (e) {
              errors.push(`Could not read ticket ${roundId} on ${c.address}: ${e instanceof Error ? e.message : String(e)}`)
              return undefined
            }
          }))
          return bets.filter((b): b is MyBet => !!b)
        } catch (e) {
          errors.push(`${c.address}: ${e instanceof Error ? e.message : String(e)}`)
          return [] as MyBet[]
        }
      }))
      const list = groups.flat()
      list.sort((a, b) => b.round.times.closeAt - a.round.times.closeAt)
      return { bets: list, scanError: errors.join('; ') || undefined }
    },
  })
}

export function poolOfRound(roundId: bigint): Address {
  return decodeRoundId(roundId).pool
}
