import { useQuery } from '@tanstack/react-query'

const API = import.meta.env.VITE_API_URL

export type PoolStatus = 'PENDING' | 'READY' | 'ONBOARDED' | 'REJECTED'

export interface Pool {
  pool: string
  token: string
  symbol: string | null
  feeTier: number
  status: PoolStatus
  /**
   * Why the keeper decided what it decided, in its own words.
   *
   * Free text on purpose, and rendered as such. It is the same string the
   * watcher logged, so a trader asking "why is there no market on my token"
   * gets the same answer the operator sees - and a new rejection reason does
   * not need this file to learn about it first.
   */
  reason: string | null
  /** WETH behind the pool's in-range liquidity. Null before anything measured it. */
  wethDepth: number | null
  cardinality: number | null
  ageSec: number
  lastCheckedSec: number | null
  /** Durations that already have a market, in seconds. */
  marketDurations: number[]
}

export interface PoolFeed {
  chainId: number
  /** False on a chain whose markets come from a feed rather than a pool. */
  poolBacked: boolean
  pools: Pool[]
}

export function usePools(status?: PoolStatus) {
  return useQuery<PoolFeed>({
    queryKey: ['pools', status],
    queryFn: async () => {
      const url = status ? `${API}/api/pools?status=${status}` : `${API}/api/pools`
      const res = await fetch(url)
      if (!res.ok) throw new Error('Failed to fetch pools')
      return res.json()
    },
    // Slower than markets: a pool's depth and its markets change over minutes,
    // not seconds, and the feed is a browse surface rather than a trading one.
    refetchInterval: 30_000,
    staleTime: 20_000,
  })
}
