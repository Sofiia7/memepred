import { useEffect, useMemo, useState } from 'react'
import { CURRENCY_SYMBOL, IS_POOL_BACKED } from '../lib/contracts'
import { useMarkets, type Market } from '../hooks/useMarkets'
import { useMarketStats, symbolFromStats } from '../hooks/useMarketStats'
import { ScreenTitle, StatStrip } from '../components/ui/AppShell'
import { MarketCardUI, type PickedBet } from '../components/ui/MarketCard'
import { Composer } from '../components/ui/Composer'
import { shortMarketHint } from '../lib/marketHint'

/**
 * The key a market is grouped under.
 *
 * On IS_POOL_BACKED, that has to be feedId (the pool address), not the
 * token's symbol() string: a look-alike token can share a real one's symbol,
 * and grouping by that string alone silently merged them onto one card with
 * no way to tell which pool a bet was actually against. On Base there is no
 * pool - feedId is the RedStone feed id, shared by design across the
 * durations of a single listed coin - so the symbol remains the right key.
 */
function groupKey(m: Market): string {
  return IS_POOL_BACKED ? m.feedId.toLowerCase() : (m.feedSymbol || 'UNKNOWN').toUpperCase()
}

function groupMarkets(markets: Market[]): Record<string, Market[]> {
  const out: Record<string, Market[]> = {}
  for (const m of markets) {
    if (m.status !== 'OPEN') continue
    const k = groupKey(m)
    ;(out[k] ??= []).push(m)
  }
  return out
}

export function Markets() {
  const { data: markets, isLoading } = useMarkets('OPEN')
  const { data: stats } = useMarketStats()
  const [picked, setPicked] = useState<PickedBet | null>(null)

  const groups = useMemo(() => groupMarkets(markets ?? []), [markets])
  const groupKeys = Object.keys(groups).sort()

  // Whether the short markets are missing is decided by the API payload alone,
  // so it can be tested without rendering anything - see lib/marketHint.ts.
  const missing = shortMarketHint(markets ?? [], 0) !== null

  const [waitingSince, setWaitingSince] = useState<number | null>(null)
  useEffect(() => {
    setWaitingSince((prev) => (missing ? prev ?? Date.now() : null))
  }, [missing])

  // No timer of its own: useMarkets refetches every 15s and each refetch
  // re-renders, which is what carries the message from one wording to the next.
  const hint = shortMarketHint(
    markets ?? [],
    waitingSince === null ? null : Date.now() - waitingSince,
  )
  const vol = stats?.volume24h ?? 0
  const volText = vol >= 1e6
    ? `${IS_POOL_BACKED ? '' : '$'}${(vol / 1e6).toFixed(2)}M`
    : vol >= 1e3
      ? `${IS_POOL_BACKED ? '' : '$'}${(vol / 1e3).toFixed(1)}K`
      : `${IS_POOL_BACKED ? '' : '$'}${vol.toFixed(IS_POOL_BACKED ? 4 : 0)}`

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
          { k: '24h Volume', v: volText, u: CURRENCY_SYMBOL },
          { k: 'Active', v: String(groupKeys.length), u: IS_POOL_BACKED ? 'pools' : 'symbols' },
        ]}
      />

      {isLoading && <div className="empty-state">Loading markets…</div>}
      {!isLoading && groupKeys.length === 0 && <div className="empty-state">No open markets yet</div>}

      {hint && (
        <div className={'mkt-hint' + (hint.slow ? ' mkt-hint-slow' : '')}>{hint.text}</div>
      )}

      {groupKeys.map((key) => {
        const group = groups[key]
        const displaySymbol = group[0]?.feedSymbol || 'UNKNOWN'
        // Stats are aggregated by symbol on the backend, not by pool - two
        // distinct pools that happen to share a symbol would share this
        // price/24h-change too. The card's identity (which pool this actually
        // is) does not depend on this lookup; only the price ticker does.
        const s = symbolFromStats(stats, displaySymbol)
        return (
          <MarketCardUI
            key={key}
            symbol={displaySymbol}
            feedId={group[0]?.feedId}
            livePrice={s?.price ?? group[0]?.entryPrice ?? 0}
            chg24h={s?.chg24h ?? 0}
            markets={group}
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
