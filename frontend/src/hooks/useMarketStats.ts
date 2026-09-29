import { useQuery } from '@tanstack/react-query'

const API = import.meta.env.VITE_API_URL

export interface SymbolStat {
  /**
   * The feed the price belongs to: the pool address, left-padded to 32 bytes,
   * exactly as a market carries it. Absent on a backend that still aggregates
   * by symbol.
   */
  feedId?: string
  symbol: string
  price:  number
  chg24h: number
}

export interface MarketStats {
  volume24h: number
  /** One entry per feed. Named `symbols` for the endpoint's older, per-symbol shape. */
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

/** Case- and padding-insensitive: 0x000...abc and 0xABC are the same pool. */
function sameFeed(a: string, b: string): boolean {
  const norm = (id: string) => id.toLowerCase().replace(/^0x/, '').replace(/^0+/, '')
  return norm(a) === norm(b)
}

/**
 * How far the symbol may be trusted when the feed is not in the stats.
 *
 *  - 'unkeyed' (pool-backed chains): only a row that carries no feedId at all,
 *    i.e. a backend that has not learned to send one. A symbol there is
 *    whatever the token's deployer chose, two pools can share one (a look-alike
 *    token is exactly that), and a row that names another feed is another pool:
 *    "no price yet" is the honest answer, a look-alike's price is not.
 *  - 'any' (Base): the backend keys its rows by symbol, because a symbol IS the
 *    feed there, and the feedId it reports can be one an older oracle wrote for
 *    the same symbol, so it does not have to match the market's.
 */
export type SymbolFallback = 'unkeyed' | 'any'

/**
 * The price row for one market: by feed first, then by symbol as far as
 * `symbolFallback` allows.
 */
export function statForMarket(
  stats: MarketStats | undefined,
  feedId: string | undefined,
  symbol: string | undefined,
  symbolFallback: SymbolFallback = 'unkeyed',
): SymbolStat | undefined {
  const rows = stats?.symbols
  if (!rows) return undefined

  if (feedId) {
    const byFeed = rows.find((s) => s.feedId && sameFeed(s.feedId, feedId))
    if (byFeed) return byFeed
  }
  if (symbol) {
    const sym = symbol.toUpperCase()
    return rows.find(
      (s) => s.symbol.toUpperCase() === sym && (symbolFallback === 'any' || !s.feedId),
    )
  }
  return undefined
}

/** The pre-feed lookup, kept for callers that only know a symbol. */
export function symbolFromStats(stats: MarketStats | undefined, sym: string): SymbolStat | undefined {
  return stats?.symbols.find((s) => s.symbol.toUpperCase() === sym.toUpperCase())
}
