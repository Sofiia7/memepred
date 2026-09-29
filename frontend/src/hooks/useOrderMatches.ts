import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { fetchOrderRecord, OrderApiError, type OrderApiMatch } from '../lib/orderApi'
import type { MatchOutcome } from '../lib/orderModel'

export type { MatchOutcome }
export type OrderMatchInfo = OrderApiMatch

/** What every piece of per-order state here is keyed by. Case-insensitive on the address. */
export function orderKey(marketAddress: string, orderId: bigint): string {
  return `${marketAddress.toLowerCase()}:${orderId.toString()}`
}

interface Snapshot {
  key: string
  matches: OrderMatchInfo[]
  /** The API's `payout` for this order: accrued winnings, or the paid amount once claimed. */
  payout: number | null
  /** At least one answer (including a 404) has arrived for this key. */
  loaded: boolean
  /** The latest attempt failed for a reason other than "no such order". */
  error: boolean
  notFound: boolean
}

const empty = (key: string): Snapshot => ({
  key,
  matches: [],
  payout: null,
  loaded: false,
  error: false,
  notFound: false,
})

/**
 * Every match an order has ever been part of - see markets.ts's
 * /:address/orders/:orderId for why (audit A04, 2026-09-28): OrderStatusCard
 * used to see only order.matchId, the order's FIRST match, and rendered as if
 * that were the whole order. This is what lets it show the honest aggregate
 * instead, and find whichever match is actually stuck rather than always the
 * first one.
 *
 * State is keyed by (market, orderId) and is never shown for any other key.
 * React Router does not remount a page across param changes, so the old hook
 * kept order 1's matches on screen after navigating to order 2 and, on a 404,
 * kept them there for good. A snapshot now carries the key it was fetched for:
 * a mismatch reads as "nothing loaded yet", a response for a key that is no
 * longer current is dropped, and a 404 clears the list.
 *
 * A failure other than 404 keeps the last list of the SAME order (a network
 * blip should not blank the card) and raises `isError` so callers can say the
 * breakdown may be out of date.
 *
 * Plain fetch + poll, not react-query: this hook has to work in tests that
 * render it with no QueryClientProvider. A failed or not-yet-resolved fetch just
 * leaves `matches` empty - callers fall back to their single-match behaviour,
 * they do not crash on it.
 */
export function useOrderMatches(marketAddress: Address, orderId: bigint) {
  const key = orderKey(marketAddress, orderId)
  const [snap, setSnap] = useState<Snapshot>(() => empty(key))

  // The key the latest render is about. An answer that arrives for an earlier
  // one is stale by definition, whichever request it was.
  const currentKey = useRef(key)
  currentKey.current = key

  const refetch = useCallback(async () => {
    if (orderId <= 0n) return
    const forKey = key
    try {
      const rec = await fetchOrderRecord(marketAddress, orderId)
      if (currentKey.current !== forKey) return
      setSnap({
        key: forKey,
        matches: Array.isArray(rec?.matches) ? rec.matches : [],
        payout: typeof rec?.payout === 'number' ? rec.payout : null,
        loaded: true,
        error: false,
        notFound: false,
      })
    } catch (e) {
      if (currentKey.current !== forKey) return
      if (e instanceof OrderApiError && e.status === 404) {
        setSnap({ ...empty(forKey), loaded: true, notFound: true })
      } else {
        setSnap((prev) => (prev.key === forKey ? { ...prev, error: true } : { ...empty(forKey), error: true }))
      }
    }
  }, [marketAddress, orderId, key])

  useEffect(() => {
    void refetch()
    const id = setInterval(() => void refetch(), 10_000)
    return () => clearInterval(id)
  }, [refetch])

  const view = snap.key === key ? snap : empty(key)

  return {
    matches: view.matches,
    payout: view.payout,
    isLoading: orderId > 0n && !view.loaded && !view.error,
    isError: view.error,
    notFound: view.notFound,
    refetch,
  }
}
