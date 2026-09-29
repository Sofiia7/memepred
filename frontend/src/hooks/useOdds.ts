import { useReadContract } from 'wagmi'
import type { Address } from 'viem'
import { ORDERBOOK_MARKET_ABI } from '../lib/contracts'

/**
 * Read pending depth on each side.
 *
 * What comes back is the two queues' LENGTHS (getPendingDepth returns
 * `pendingUpQueue.length, pendingDownQueue.length`): how many orders are
 * waiting, not how much is staked, and not the chance that either side wins.
 * The payout of a bet is fixed and does not depend on them. `probUp` is the
 * imbalance of the two queues written as a ratio, kept because it was here; it
 * is not a probability and nothing on screen should present it as one.
 */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export function useOdds(marketAddress: Address) {
  const { data, isLoading, refetch } = useReadContract({
    address:      marketAddress,
    abi:          ORDERBOOK_MARKET_ABI,
    functionName: 'getPendingDepth',
    query:        { enabled: marketAddress?.toLowerCase() !== ZERO_ADDRESS }
  })

  if (!data) return { upDepth: 0n, downDepth: 0n, probUp: 0.5, isLoading, refetch }

  const upDepth   = data[0] as bigint
  const downDepth = data[1] as bigint
  const total = upDepth + downDepth
  const probUp = total === 0n ? 0.5 : Number(downDepth) / Number(total)
  // The side with LESS queue is the one that fills sooner. That is all this says.
  return { upDepth, downDepth, probUp, isLoading, refetch }
}
