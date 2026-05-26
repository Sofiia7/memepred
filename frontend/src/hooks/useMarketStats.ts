import { useQuery } from '@tanstack/react-query'

const API = import.meta.env.VITE_API_URL

export interface SymbolStat {
  symbol: string
  price:  number
  chg24h: number
}

export interface MarketStats {
  volume24h: number
  symbols:   SymbolStat[]
}

export function useMarketStats() {
  return useQuery<MarketStats>({
    queryKey: ['marketStats'],
    queryFn:  async () => {
      const r = await fetch(`${API}/api/markets/stats`)
      if (!r.ok) throw new Error('stats')
      return r.json()
    },
    refetchInterval: 30_000,
    staleTime:       20_000,
  })
}

export function symbolFromStats(stats: MarketStats | undefined, sym: string): SymbolStat | undefined {
  return stats?.symbols.find(s => s.symbol.toUpperCase() === sym.toUpperCase())
}
