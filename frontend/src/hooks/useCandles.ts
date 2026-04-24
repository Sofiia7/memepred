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

export function useCandles(feedId: string, tf: Timeframe = '5m') {
  return useQuery<Candle[]>({
    queryKey: ['candles', feedId, tf],
    queryFn:  async () => {
      const res = await fetch(`${API}/api/candles/${feedId}?tf=${tf}&limit=100`)
      if (!res.ok) throw new Error('Failed to fetch candles')
      return res.json()
    },
    refetchInterval: 30_000,
    staleTime:       20_000
  })
}

export function useProbHistory(marketAddress: string) {
  return useQuery<ProbPoint[]>({
    queryKey: ['prob-history', marketAddress],
    queryFn:  async () => {
      const res = await fetch(`${API}/api/candles/${marketAddress}/prob-history`)
      if (!res.ok) throw new Error('Failed to fetch prob history')
      return res.json()
    },
    refetchInterval: 15_000,
    staleTime:       10_000
  })
}
