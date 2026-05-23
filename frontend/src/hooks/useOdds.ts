import { useReadContract } from 'wagmi'
import type { Address } from 'viem'
import { ORDERBOOK_MARKET_ABI } from '../lib/contracts'

/**
 * Read pending depth on each side. With perfect symmetry the implied
 * probability is depthUp / (depthUp + depthDown); otherwise it leans toward
 * the longer queue (more demand on that side).
 */
export function useOdds(marketAddress: Address) {
  const { data, isLoading, refetch } = useReadContract({
    address:      marketAddress,
    abi:          ORDERBOOK_MARKET_ABI,
    functionName: 'getPendingDepth'
  })

  if (!data) return { upDepth: 0n, downDepth: 0n, probUp: 0.5, isLoading, refetch }

  const upDepth   = data[0] as bigint
  const downDepth = data[1] as bigint
  const total = upDepth + downDepth
  const probUp = total === 0n ? 0.5 : Number(downDepth) / Number(total)
  // The side with LESS queue has higher fill probability and lower implied price.
  return { upDepth, downDepth, probUp, isLoading, refetch }
}
