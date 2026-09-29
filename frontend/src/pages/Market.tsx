import { useParams, useNavigate, Link } from 'react-router-dom'
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
import { useBetBusy } from '../hooks/useBetBusy'
import { useNow, countdownFrom } from '../hooks/useNow'
import { makeFreshness, useFreshness, worstOf } from '../hooks/useFreshness'
import { symbolMeta, formatPrice, formatDuration, isContinuousMarket } from '../lib/symbols'
import { parseMarketParam } from '../lib/routeParams'
import { ZERO_ADDRESS } from '../lib/orderModel'
import { Chev } from '../components/ui/icons'
import { IS_POOL_BACKED } from '../lib/chain'
import { CONTRACTS, MARKET_FACTORY_ABI } from '../lib/contracts'

export function Market() {
  const { address } = useParams<{ address: string }>()
  const navigate = useNavigate()
  // The route parameter is untrusted text. Until it has passed isAddress it is
  // never used as an address: hooks below still run (Rules of Hooks) but on the
  // zero address, with their reads switched off, and the page shows "Invalid
  // market link" instead of a verification error with a Retry that cannot work.
  const validAddress = parseMarketParam(address)
  const marketAddress = (validAddress ?? ZERO_ADDRESS) as Address
  const [tf, setTf] = useState<Timeframe>('5m')
  const [picked, setPicked] = useState<PickedBet | null>(null)

  const { data: allMarkets, isError: marketsError, refetch: refetchMarkets, dataUpdatedAt: marketsUpdatedAt } = useMarkets()
  const market = validAddress
    ? allMarkets?.find((m) => m.address.toLowerCase() === marketAddress.toLowerCase())
    : undefined

  const feedId = market?.feedId
  const symbol = market?.feedSymbol ?? 'UNKNOWN'
  const durationSec = market?.duration ?? 0
  const closeTime = market?.closeTime ?? 0

  const { upDepth, downDepth } = useOdds(marketAddress)
  const { display: livePrice, raw: pythRaw, status: priceStatus } = usePythPrice(feedId)
  const {
    data: candles,
    isLoading: candlesLoading,
    isError: candlesError,
    refetch: refetchCandles,
  } = useCandles(feedId ?? '', tf)
  const {
    data: probHistory,
    isLoading: probLoading,
    isError: probError,
    refetch: refetchProb,
  } = useProbHistory(validAddress ?? '')
  // The dot next to the title is only as green as the data behind it: the
  // markets list (refetched every 15s) and the price feed (its own stale flag).
  const marketsFresh = useFreshness(
    { dataUpdatedAt: marketsUpdatedAt, isError: marketsError, hasData: !!allMarkets },
    45_000,
  )
  const freshness = worstOf(
    marketsFresh,
    priceStatus === 'live'
      ? makeFreshness('live', 'live')
      : priceStatus === 'unavailable'
        ? makeFreshness('error', 'price unavailable')
        : priceStatus === 'stale'
          ? makeFreshness('stale', 'price stale')
          : makeFreshness('loading', 'price loading'),
  )
  // Above the early return, not inside the JSX below it. Called after the
  // return, this is a hook whose presence depends on a prop - the Rules-of-
  // Hooks violation that white-screened MarketCard and Order once each.
  const nowSec = useNow(1000)
  // True while the Composer is placing a bet: a pick made then could not change it (audit U01).
  const betBusy = useBetBusy()

  // The address in the URL is untrusted input - a link to /market/0xAttacker
  // on the real domain is otherwise indistinguishable from a real market, and
  // usePlaceBet used to approve an arbitrary contract before anything checked
  // that. isMarket() is the on-chain source of truth: it is only ever true for
  // an address MarketFactory/PoolMarketFactory itself created. Also above the
  // early return, for the same Rules-of-Hooks reason as useNow above.
  const {
    data: isRealMarket,
    isLoading: verifyingMarket,
    isError: marketCheckErrored,
    refetch: refetchIsMarket,
  } = useReadContract({
    address: CONTRACTS.MARKET_FACTORY,
    abi: MARKET_FACTORY_ABI,
    functionName: 'isMarket',
    args: [marketAddress],
    query: { enabled: !!validAddress },
  })

  if (!validAddress) {
    return (
      <>
        <ScreenTitle title="Invalid market link" />
        <div className="empty-state">
          This link does not contain a valid market address. Check it for typos, or pick a market from the list.
        </div>
        <Link to="/" className="cta">Back to markets</Link>
      </>
    )
  }
  const meta = symbolMeta(symbol)
  const continuous = IS_POOL_BACKED || (market !== undefined && isContinuousMarket(market.closeTime))
  const headLabel = continuous ? 'continuous market' : countdownFrom(closeTime, nowSec)
  const notAMarket = isRealMarket === false
  // Audit A05 (2026-09-28): an RPC error leaves `data` undefined and
  // `isLoading` false, which used to read identically to "confirmed not a
  // market is false" and let the Composer through on a market that was never
  // actually verified. This is its own state now, distinct from both
  // "confirmed real" and "confirmed fake", with its own Retry rather than
  // silently trusting the address.
  const verifyFailed = marketCheckErrored && isRealMarket === undefined

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

      <ScreenTitle
        title={`${symbol} / ${IS_POOL_BACKED ? 'WETH' : 'USD'}`}
        live
        liveLabel={freshness.level === 'live' ? headLabel : `${headLabel} · ${freshness.label}`}
        liveColor={freshness.color}
      />

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
            <div className="coin-chg" style={priceStatus === 'live' ? undefined : { opacity: 0.6 }}>
              {priceStatus === 'live'
                ? <><Chev dir="up" /> live</>
                : priceStatus === 'unavailable'
                  ? 'unavailable'
                  : priceStatus === 'stale'
                    ? 'last known'
                    : 'loading'}
            </div>
          </div>
        </div>
      </div>

      <MarketChart
        feedId={feedId ?? ''}
        marketAddress={marketAddress}
        symbol={market?.feedSymbol}
        candles={candles}
        probHistory={probHistory}
        candlesLoading={candlesLoading}
        candlesError={candlesError}
        onRetryCandles={() => refetchCandles()}
        probLoading={probLoading}
        probError={probError}
        onRetryProb={() => refetchProb()}
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
      ) : verifyFailed ? (
        <div className="empty-state" style={{ margin: '12px 0' }}>
          Couldn't verify this is a real market.
          <button className="cta" style={{ marginTop: 10 }} onClick={() => refetchIsMarket()}>
            RETRY
          </button>
        </div>
      ) : (
        <>
          <div className="ud" style={{ padding: 0, marginBottom: 12 }}>
            <button
              className={'b b-up ' + (picked?.side === 'up' ? 'sel' : '')}
              disabled={verifyingMarket || betBusy}
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
              disabled={verifyingMarket || betBusy}
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
