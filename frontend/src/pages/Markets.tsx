import { useEffect, useMemo, useState } from 'react'
import { CURRENCY_SYMBOL, IS_POOL_BACKED } from '../lib/contracts'
import { useMarkets, type Market } from '../hooks/useMarkets'
import { useMarketStats, statForMarket } from '../hooks/useMarketStats'
import { useFreshness } from '../hooks/useFreshness'
import { ScreenTitle, StatStrip } from '../components/ui/AppShell'
import { MarketCardUI, type PickedBet } from '../components/ui/MarketCard'
import { Composer } from '../components/ui/Composer'
import { ApiError } from '../components/ui/ApiError'
import { shortMarketHint } from '../lib/marketHint'
import { TARGET_CHAIN } from '../lib/chain'
import { ROUNDS_ENABLED } from '../rounds/flag'
import { ROUNDS_CONFIG } from '../rounds/roundsAbi'
import { Link } from 'react-router-dom'

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
  const { data: markets, isLoading, isError, refetch, dataUpdatedAt } = useMarkets('OPEN')
  const { data: stats } = useMarketStats()
  // useMarkets refetches every 15s; three missed rounds and the board is no
  // longer "live", whatever the dot used to claim.
  const freshness = useFreshness({ dataUpdatedAt, isError, hasData: !!markets }, 45_000)
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
        title={TARGET_CHAIN.testnet && ROUNDS_ENABLED && IS_POOL_BACKED ? 'Legacy markets' : 'Live markets'}
        live
        liveLabel={freshness.label}
        liveColor={freshness.color}
        icon={
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
            <circle cx="12" cy="12" r="3" fill="currentColor" />
          </svg>
        }
      />

      {TARGET_CHAIN.testnet && ROUNDS_ENABLED && IS_POOL_BACKED && (
        <p className="legacy-notice" role="note">
          This older testnet market uses a fixture WETH that cannot be unwrapped. For the current demo, <Link to="/rounds">{ROUNDS_CONFIG.nativeEth ? 'bet and collect directly in test ETH on Rounds' : 'use Rounds'}</Link>.
        </p>
      )}

      <StatStrip
        items={[
          { k: '24h Volume', v: volText, u: CURRENCY_SYMBOL },
          { k: 'Active', v: String(groupKeys.length), u: IS_POOL_BACKED ? 'pools' : 'symbols' },
        ]}
      />

      {isLoading && <div className="empty-state">Loading markets…</div>}
      {isError && <ApiError message="Couldn't load markets" onRetry={refetch} />}
      {!isLoading && !isError && groupKeys.length === 0 && <div className="empty-state">No open markets yet</div>}

      {hint && (
        <div className={'mkt-hint' + (hint.slow ? ' mkt-hint-slow' : '')}>{hint.text}</div>
      )}

      <div className="markets-layout">
      <div className="markets-list">
      {groupKeys.map((key) => {
        const group = groups[key]
        const displaySymbol = group[0]?.feedSymbol || 'UNKNOWN'
        // Looked up by feed first: two pools can share a symbol, and a symbol
        // lookup gives the second the first one's price and 24h change. On
        // Base, where the backend keys its rows by symbol, the symbol is the
        // key; on a pool-backed chain it only serves a backend that has not
        // started sending feedIds (see SymbolFallback).
        const s = statForMarket(stats, group[0]?.feedId, displaySymbol, IS_POOL_BACKED ? 'unkeyed' : 'any')
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

      </div>
      <Composer picked={picked} onClear={() => setPicked(null)} />
      </div>
    </>
  )
}
