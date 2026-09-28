import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'

export type MatchOutcome = 'pending' | 'won' | 'lost' | 'tied' | 'emergency_refunded'

export interface OrderMatchInfo {
  matchId:   string
  isLpMatch: boolean
  amount:    number
  settled:   boolean
  settleAt:  number
  outcome:   MatchOutcome
}

const API = import.meta.env.VITE_API_URL

/**
 * Every match an order has ever been part of - see markets.ts's
 * /:address/orders/:orderId for why (audit A04, 2026-09-28): OrderStatusCard
 * used to see only order.matchId, the order's FIRST match, and rendered as if
 * that were the whole order. This is what lets it show the honest aggregate
 * instead, and find whichever match is actually stuck rather than always the
 * first one.
 *
 * Plain fetch + poll, not react-query: this hook has to work inside
 * OrderStatusCard's existing tests, which render it with no
 * QueryClientProvider. A failed or not-yet-resolved fetch just leaves
 * `matches` empty - callers fall back to their existing single-match
 * behaviour, they do not crash on it.
 */
export function useOrderMatches(marketAddress: Address, orderId: bigint) {
  const [matches, setMatches] = useState<OrderMatchInfo[]>([])

  const refetch = useCallback(async () => {
    if (orderId <= 0n) return
    try {
      const res = await fetch(`${API}/api/markets/${marketAddress}/orders/${orderId}`)
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data?.matches)) setMatches(data.matches)
    } catch {
      // Network blip or no backend in this environment - keep the last
      // known list rather than clearing it out from under the UI.
    }
  }, [marketAddress, orderId])

  useEffect(() => {
    refetch()
    const id = setInterval(refetch, 10_000)
    return () => clearInterval(id)
  }, [refetch])

  return { matches, refetch }
}
