import { useMemo, useState } from 'react'
import { useMarkets, type Market } from '../hooks/useMarkets'
import { useMarketStats, symbolFromStats } from '../hooks/useMarketStats'
import { ScreenTitle, StatStrip } from '../components/ui/AppShell'
import { MarketCardUI, type PickedBet } from '../components/ui/MarketCard'
import { Composer } from '../components/ui/Composer'

function groupBySymbol(markets: Market[]): Record<string, Market[]> {
  const out: Record<string, Market[]> = {}
  for (const m of markets) {
    if (m.status !== 'OPEN') continue
    const k = (m.feedSymbol || 'UNKNOWN').toUpperCase()
    ;(out[k] ??= []).push(m)
  }
  return out
}

export function Markets() {
  const { data: markets, isLoading } = useMarkets('OPEN')
  const { data: stats } = useMarketStats()
  const [picked, setPicked] = useState<PickedBet | null>(null)

  const groups = useMemo(() => groupBySymbol(markets ?? []), [markets])
  const symbols = Object.keys(groups).sort()
  const vol = stats?.volume24h ?? 0
  const volText = vol >= 1e6 ? `$${(vol / 1e6).toFixed(2)}M` : vol >= 1e3 ? `$${(vol / 1e3).toFixed(1)}K` : `$${vol.toFixed(0)}`

  return (
    <>
      <ScreenTitle
        title="Live markets"
        live
        icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="#4d8dff" strokeWidth="2" />
            <circle cx="12" cy="12" r="3" fill="#4d8dff" />
          </svg>
        }
      />

      <StatStrip
        items={[
          { k: '24h Volume', v: volText, u: 'USDC' },
          { k: 'Active', v: String(symbols.length), u: 'symbols' },
        ]}
      />

      {isLoading && <div className="empty-state">Loading markets…</div>}
      {!isLoading && symbols.length === 0 && <div className="empty-state">No open markets yet</div>}

      {symbols.map((sym) => {
        const s = symbolFromStats(stats, sym)
        return (
          <MarketCardUI
            key={sym}
            symbol={sym}
            livePrice={s?.price ?? groups[sym][0]?.entryPrice ?? 0}
            chg24h={s?.chg24h ?? 0}
            markets={groups[sym]}
            picked={picked}
            onPick={setPicked}
          />
        )
      })}

      <div style={{ height: 280 }} />

      <Composer picked={picked} onClear={() => setPicked(null)} />
    </>
  )
}
