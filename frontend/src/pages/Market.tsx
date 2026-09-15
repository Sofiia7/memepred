import { useParams, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useReadContract } from 'wagmi'
import type { Address } from 'viem'
import { ScreenTitle, StatStrip } from '../components/ui/AppShell'
import { Composer } from '../components/ui/Composer'
import { ApiError } from '../components/ui/ApiError'
import type { PickedBet } from '../components/ui/MarketCard'
import { MarketChart, type Timeframe } from '../components/MarketChart'
import { useCandles, useProbHistory } from '../hooks/useCandles'
import { useMarkets } from '../hooks/useMarkets'
import { useOdds } from '../hooks/useOdds'
import { usePythPrice } from '../hooks/usePythPrice'
import { useNow, countdownFrom } from '../hooks/useNow'
import { symbolMeta, formatPrice, formatDuration } from '../lib/symbols'
import { Chev } from '../components/ui/icons'
import { IS_POOL_BACKED } from '../lib/chain'
import { CONTRACTS, MARKET_FACTORY_ABI } from '../lib/contracts'

export function Market() {
  const { address } = useParams<{ address: string }>()
  const navigate = useNavigate()
  const marketAddress = address as Address
  const [tf, setTf] = useState<Timeframe>('5m')
  const [picked, setPicked] = useState<PickedBet | null>(null)

  const { data: allMarkets, isError: marketsError, refetch: refetchMarkets } = useMarkets()
  const market = allMarkets?.find((m) => m.address.toLowerCase() === marketAddress?.toLowerCase())

  const feedId = market?.feedId
  const symbol = market?.feedSymbol ?? 'UNKNOWN'
  const durationSec = market?.duration ?? 0
  const closeTime = market?.closeTime ?? 0

  const { upDepth, downDepth } = useOdds(marketAddress)
  const { display: livePrice, raw: pythRaw, stale: priceStale } = usePythPrice(feedId)
  const { data: candles } = useCandles(feedId ?? '', tf)
  const { data: probHistory } = useProbHistory(marketAddress)
  // Above the early return, not inside the JSX below it. Called after the
  // return, this is a hook whose presence depends on a prop - the Rules-of-
  // Hooks violation that white-screened MarketCard and Order once each.
  const nowSec = useNow(1000)

  // The address in the URL is untrusted input - a link to /market/0xAttacker
  // on the real domain is otherwise indistinguishable from a real market, and
  // usePlaceBet used to approve an arbitrary contract before anything checked
  // that. isMarket() is the on-chain source of truth: it is only ever true for
  // an address MarketFactory/PoolMarketFactory itself created. Also above the
  // early return, for the same Rules-of-Hooks reason as useNow above.
  const { data: isRealMarket, isLoading: verifyingMarket } = useReadContract({
    address: CONTRACTS.MARKET_FACTORY,
    abi: MARKET_FACTORY_ABI,
    functionName: 'isMarket',
    args: [marketAddress ?? '0x0000000000000000000000000000000000000000'],
    query: { enabled: !!marketAddress },
  })

  if (!marketAddress) return <div className="empty-state">Invalid market</div>
  const meta = symbolMeta(symbol)
  const notAMarket = isRealMarket === false

  return (
    <>
      <button
        className="clear"
        onClick={() => navigate(-1)}
        style={{ padding: '0 0 8px', fontSize: 11, letterSpacing: '.14em', display: 'block' }}
      >
        ← BACK
      </button>

      {/* Non-blocking: other reads on this page (chart, odds, price) have
          their own resilience, so a failed markets-list fetch shouldn't hide
          the rest of the screen - only shown when there's nothing to fall
          back on for this market's own basic facts (symbol, duration). */}
      {marketsError && !market && (
        <ApiError message="Couldn't load market data" onRetry={refetchMarkets} />
      )}

      <ScreenTitle title={`${symbol} / ${IS_POOL_BACKED ? 'WETH' : 'USD'}`} live liveLabel={IS_POOL_BACKED ? 'continuous market' : countdownFrom(closeTime, nowSec)} liveColor="var(--up)" />

      <div className="market" style={{ marginBottom: 12 }}>
        <div className="coin">
          <div className="coin-l">
            <div className={'coin-icon ' + meta.iconClass}>{meta.glyph}</div>
            <div>
              <div className="coin-name">{symbol}<span className="pair"> / {IS_POOL_BACKED ? 'WETH' : 'USD'}</span></div>
              <div className="coin-sub">{meta.name} · {formatDuration(durationSec)}</div>
            </div>
          </div>
          <div className="coin-r">
            <div className="coin-price">{IS_POOL_BACKED ? `${formatPrice(livePrice)} WETH` : `$${formatPrice(livePrice)}`}</div>
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
          // getPendingDepth returns the two queues' LENGTHS, not their value:
          // `return (pendingUpQueue.length, pendingDownQueue.length)`. This
          // was rendered as `$${length / 1e6} USDC`, so a queue holding three
          // real orders showed as $0.00 - the number was never money, and
          // dividing it by a currency's decimals made it neither.
          { k: 'UP queue', v: Number(upDepth), u: Number(upDepth) === 1 ? 'order' : 'orders', tone: 'up' },
          { k: 'DOWN queue', v: Number(downDepth), u: Number(downDepth) === 1 ? 'order' : 'orders', tone: 'dn' },
        ]}
      />

      {notAMarket ? (
        <div className="empty-state" style={{ margin: '12px 0' }}>
          This address was not created by FlipTheMeme's market factory - it is
          not a real market. Do not approve any token spend on this page.
        </div>
      ) : (
        <>
          <div className="ud" style={{ padding: 0, marginBottom: 12 }}>
            <button
              className={'b b-up ' + (picked?.side === 'up' ? 'sel' : '')}
              disabled={verifyingMarket}
              onClick={() => setPicked({
                marketAddress, feedId: feedId ?? '', symbol, durationSec,
                side: 'up', oddsPct: 0,
              })}
            >
              <span className="side"><Chev dir="up" /> UP</span>
              <span className="pct">{upDepth.toString()} waiting</span>
            </button>
            <button
              className={'b b-dn ' + (picked?.side === 'down' ? 'sel' : '')}
              disabled={verifyingMarket}
              onClick={() => setPicked({
                marketAddress, feedId: feedId ?? '', symbol, durationSec,
                side: 'down', oddsPct: 0,
              })}
            >
              <span className="side"><Chev dir="down" /> DOWN</span>
              <span className="pct">{downDepth.toString()} waiting</span>
            </button>
          </div>

          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)', letterSpacing: '.1em', textAlign: 'center', padding: '4px 0' }}>
            ENTRY TWAP {pythRaw > 0n ? (Number(pythRaw) / 1e18).toPrecision(6) : '-'} {IS_POOL_BACKED ? 'WETH per token' : 'USD'} · SLIPPAGE 1%
          </div>

          <div style={{ height: 280 }} />

          {/* isMarket() still loading: withhold the Composer rather than
              trust the address by default while we wait. picked can only be
              set from the buttons above, which are disabled until then, so
              there is nothing to show yet either way. */}
          {!verifyingMarket && (
            <Composer picked={picked} onClear={() => setPicked(null)} />
          )}
        </>
      )}
    </>
  )
}
