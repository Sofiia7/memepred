import { useQuery } from '@tanstack/react-query'

const API = import.meta.env.VITE_API_URL

export interface Market {
  address:    string
  feedId:     string
  feedSymbol: string
  duration:   number
  openTime:   number
  closeTime:  number
  entryPrice: number
  exitPrice:  number | null
  status:     'OPEN' | 'CLOSED' | 'RESOLVED' | 'REFUNDED'
  upWon:      boolean | null
  upPool:     number
  downPool:   number
}

export function useMarkets(status?: string) {
  return useQuery<Market[]>({
    queryKey: ['markets', status],
    queryFn:  async () => {
      const url = status
        ? `${API}/api/markets?status=${status}`
        : `${API}/api/markets`
      const res = await fetch(url)
      if (!res.ok) throw new Error('Failed to fetch markets')
      return res.json()
    },
    refetchInterval: 15_000,
    staleTime:       10_000
  })
}
