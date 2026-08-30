import { useParams, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import type { Address } from 'viem'
import { ScreenTitle, StatStrip } from '../components/ui/AppShell'
import { Composer } from '../components/ui/Composer'
import type { PickedBet } from '../components/ui/MarketCard'
import { MarketChart, type Timeframe } from '../components/MarketChart'
import { useCandles, useProbHistory } from '../hooks/useCandles'
import { useMarkets } from '../hooks/useMarkets'
import { useOdds } from '../hooks/useOdds'
import { usePythPrice } from '../hooks/usePythPrice'
import { useNow, countdownFrom } from '../hooks/useNow'
import { symbolMeta, formatPrice, formatDuration } from '../lib/symbols'
import { Chev } from '../components/ui/icons'

export function Market() {
  const { address } = useParams<{ address: string }>()
  const navigate = useNavigate()
  const marketAddress = address as Address
  const [tf, setTf] = useState<Timeframe>('5m')
  const [picked, setPicked] = useState<PickedBet | null>(null)

  const { data: allMarkets } = useMarkets()
  const market = allMarkets?.find((m) => m.address.toLowerCase() === marketAddress?.toLowerCase())

  const feedId = market?.feedId
  const symbol = market?.feedSymbol ?? 'UNKNOWN'
  const durationSec = market?.duration ?? 0
  const closeTime = market?.closeTime ?? 0

  const { upDepth, downDepth, probUp } = useOdds(marketAddress)
  const { display: livePrice, raw: pythRaw, stale: priceStale } = usePythPrice(feedId)
  const { data: candles } = useCandles(feedId ?? '', tf)
  const { data: probHistory } = useProbHistory(marketAddress)
  // Above the early return, not inside the JSX below it. Called after the
  // return, this is a hook whose presence depends on a prop - the Rules-of-
  // Hooks violation that white-screened MarketCard and Order once each.
  const nowSec = useNow(1000)

  if (!marketAddress) return <div className="empty-state">Invalid market</div>
  const meta = symbolMeta(symbol)

  return (
    <>
      <button
        className="clear"
        onClick={() => navigate(-1)}
        style={{ padding: '0 0 8px', fontSize: 11, letterSpacing: '.14em', display: 'block' }}
      >
        ← BACK
      </button>

      <ScreenTitle title={`${symbol} / USD`} live liveLabel={countdownFrom(closeTime, nowSec)} liveColor="var(--up)" />

      <div className="market" style={{ marginBottom: 12 }}>
        <div className="coin">
          <div className="coin-l">
            <div className={'coin-icon ' + meta.iconClass}>{meta.glyph}</div>
            <div>
              <div className="coin-name">{symbol}<span className="pair"> / USD</span></div>
              <div className="coin-sub">{meta.name} · {formatDuration(durationSec)}</div>
            </div>
          </div>
          <div className="coin-r">
            <div className="coin-price">${formatPrice(livePrice)}</div>
            {/* A frozen price labelled "live" is a claim the app cannot
                support: a failing fetch deliberately keeps the last value on
                screen, which is right, but it has to say so. */}
            <div className="coin-chg" style={priceStale ? { opacity: 0.6 } : undefined}>
              {priceStale ? 'last known' : <><Chev dir="up" /> live</>}
            </div>
          </div>
        </div>
      </div>

      <MarketChart
        feedId={feedId ?? ''}
        marketAddress={marketAddress}
        candles={candles}
        probHistory={probHistory}
        onTfChange={setTf}
      />

      <StatStrip
        items={[
          { k: 'UP queue', v: `$${(Number(upDepth) / 1e6).toFixed(2)}`, u: 'USDC', tone: 'up' },
          { k: 'DOWN queue', v: `$${(Number(downDepth) / 1e6).toFixed(2)}`, u: 'USDC', tone: 'dn' },
        ]}
      />

      <div className="ud" style={{ padding: 0, marginBottom: 12 }}>
        <button
          className={'b b-up ' + (picked?.side === 'up' ? 'sel' : '')}
          onClick={() => setPicked({
            marketAddress, feedId: feedId ?? '', symbol, durationSec,
            side: 'up', oddsPct: Math.round(probUp * 100),
          })}
        >
          <span className="side"><Chev dir="up" /> UP</span>
          <span className="pct">{Math.round(probUp * 100)}%</span>
        </button>
        <button
          className={'b b-dn ' + (picked?.side === 'down' ? 'sel' : '')}
          onClick={() => setPicked({
            marketAddress, feedId: feedId ?? '', symbol, durationSec,
            side: 'down', oddsPct: Math.round((1 - probUp) * 100),
          })}
        >
          <span className="side"><Chev dir="down" /> DOWN</span>
          <span className="pct">{Math.round((1 - probUp) * 100)}%</span>
        </button>
      </div>

      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)', letterSpacing: '.1em', textAlign: 'center', padding: '4px 0' }}>
        EXPECTED {pythRaw > 0n ? (Number(pythRaw) / 1e18).toPrecision(6) : '-'} · SLIPPAGE 1%
      </div>

      <div style={{ height: 280 }} />

      <Composer picked={picked} onClear={() => setPicked(null)} />
    </>
  )
}
