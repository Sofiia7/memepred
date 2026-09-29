import { useQuery } from '@tanstack/react-query'

export type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d'

export interface Candle {
  time:  number
  open:  number
  high:  number
  low:   number
  close: number
}

export interface ProbPoint {
  ts:     number
  upPct:  number
  upPool: number
  dnPool: number
}

const API = import.meta.env.VITE_API_URL

/** What the candles route accepts: 0x plus 32 bytes. Anything else is a 400 the moment it is sent. */
const FEED_ID_RE = /^0x[0-9a-fA-F]{64}$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export function useCandles(feedId: string, tf: Timeframe = '5m') {
  return useQuery<Candle[]>({
    queryKey: ['candles', feedId, tf],
    // The market page renders before the markets list has told it the feed, so
    // feedId starts out empty. Fetching then asked the API for
    // /api/candles/?tf=... and got a 404 for every page load.
    enabled:  FEED_ID_RE.test(feedId),
    queryFn:  async () => {
      const res = await fetch(`${API}/api/candles/${feedId}?tf=${tf}&limit=100`)
      if (!res.ok) throw new Error('Failed to fetch candles')
      return res.json()
    },
    refetchInterval: 30_000,
    staleTime:       20_000
  })
}

/**
 * The queue's history: the share of waiting stake on the UP side over time. It
 * is NOT a probability that UP wins - payouts are fixed, and the queue leans
 * whichever way people are waiting. The chart labels it accordingly (QUEUE).
 */
export function useProbHistory(marketAddress: string) {
  return useQuery<ProbPoint[]>({
    queryKey: ['prob-history', marketAddress],
    enabled:  ADDRESS_RE.test(marketAddress),
    queryFn:  async () => {
      const res = await fetch(`${API}/api/candles/${marketAddress}/prob-history`)
      if (!res.ok) throw new Error('Failed to fetch prob history')
      return res.json()
    },
    refetchInterval: 15_000,
    staleTime:       10_000
  })
}
