import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import type { Address } from 'viem'
import type { Market } from '../../hooks/useMarkets'
import { useOdds } from '../../hooks/useOdds'
import { useNow, countdownFrom } from '../../hooks/useNow'
import { symbolMeta, formatPrice, formatDuration, shortAddr, feedIdToAddress, isContinuousMarket } from '../../lib/symbols'
import { Chev } from './icons'
import { IS_POOL_BACKED } from '../../lib/chain'
import { useBetBusy } from '../../hooks/useBetBusy'
import '../../order.css'

export interface PickedBet {
  marketAddress: Address
  feedId: string
  symbol: string
  durationSec: number
  side: 'up' | 'down'
  oddsPct: number
}

interface Props {
  symbol: string
  /**
   * The pool address this card's markets are grouped under (IS_POOL_BACKED
   * only - feedId is a RedStone feed id on Base, not an address worth
   * showing). Shown shortened so a look-alike token sharing a real one's
   * symbol is still distinguishable on the card itself, not just in the
   * grouping logic upstream.
   */
  feedId?: string
  livePrice?: number
  chg24h?: number
  markets: Market[]                 // all open markets for this symbol (different durations)
  picked: PickedBet | null
  onPick: (b: PickedBet) => void
}

function MarketQueue({ market, side }: { market: Market; side: 'up' | 'down' }) {
  const { upDepth, downDepth } = useOdds(market.address as Address)
  const count = side === 'up' ? upDepth : downDepth
  return <span className="pct">{count.toString()} waiting</span>
}

export function MarketCardUI({ symbol, feedId, livePrice = 0, chg24h = 0, markets, picked, onPick }: Props) {
  const meta = symbolMeta(symbol)
  const sorted = useMemo(() => [...markets].sort((a, b) => a.duration - b.duration), [markets])
  const [activeIdx, setActiveIdx] = useState(0)
  // Clamp instead of trusting activeIdx: if markets rolled over while the
  // user had a later tab selected, sorted can shrink and activeIdx can point
  // past the end. Hooks below must run unconditionally either way (Rules of
  // Hooks) - this keeps `active` defined-or-undefined without an early return
  // before the useOdds call.
  const safeIdx = Math.min(activeIdx, Math.max(0, sorted.length - 1))
  const active = sorted[safeIdx]
  const now = useNow(1000)
  // True while the Composer is placing a bet: a pick made then could not change it (audit U01).
  const betBusy = useBetBusy()
  if (!active) return null
  const isSelHere = picked?.marketAddress.toLowerCase() === active.address.toLowerCase()

  return (
    <div className="market">
      <div className="coin">
        <div className="coin-l">
          <div className={'coin-icon ' + meta.iconClass}>{meta.glyph}</div>
          <div>
            {/* The card's only way to the market page: chart, queue depth, the
                pool it is priced from. The link follows the selected duration. */}
            <div className="coin-name">
              <Link className="coin-name-link" to={`/market/${active.address}`}>{symbol}</Link>
              <span className="pair"> / {IS_POOL_BACKED ? 'WETH' : 'USD'}</span>
            </div>
            <div className="coin-sub">
              {meta.name}
              {/* A look-alike token can share a real one's symbol - the pool
                  address is what actually identifies this card, so it is
                  shown even though the symbol above is the prominent part. */}
              {IS_POOL_BACKED && feedId && <> · {shortAddr(feedIdToAddress(feedId))}</>}
            </div>
          </div>
        </div>
        <div className="coin-r">
          <div className="coin-price">{IS_POOL_BACKED ? formatPrice(livePrice) + ' WETH' : '$' + formatPrice(livePrice)}</div>
          <div className={'coin-chg ' + (chg24h < 0 ? 'dn' : '')}>
            <Chev dir={chg24h < 0 ? 'down' : 'up'} /> {Math.abs(chg24h).toFixed(2)}%
          </div>
        </div>
      </div>

      <div className="tf-tabs">
        {sorted.map((m, i) => (
          <button
            key={m.address}
            className={'tf-tab ' + (i === safeIdx ? 'on' : '')}
            onClick={() => setActiveIdx(i)}
          >
            <span className="tf-lbl">{formatDuration(m.duration)}</span>
            {/* A market with no close time has no round to count down to. The
                old countdownFrom(null) printed 00:00 on every Robinhood card. */}
            <span className="tf-end">{isContinuousMarket(m.closeTime) ? 'continuous' : `⌁ ${countdownFrom(m.closeTime!, now)}`}</span>
          </button>
        ))}
      </div>

      {isContinuousMarket(active.closeTime) && (
        <div className="mkt-continuous">
          Continuous market - each bet settles {formatDuration(active.duration)} after it is matched.
        </div>
      )}

      <div className="ud">
        <button
          className={'b b-up ' + (isSelHere && picked?.side === 'up' ? 'sel' : '')}
          disabled={betBusy}
          onClick={() => onPick({
            marketAddress: active.address as Address,
            feedId: active.feedId,
            symbol,
            durationSec: active.duration,
            side: 'up',
            oddsPct: 0,
          })}
        >
          <span className="side"><Chev dir="up" /> UP</span>
          <MarketQueue market={active} side="up" />
        </button>
        <button
          className={'b b-dn ' + (isSelHere && picked?.side === 'down' ? 'sel' : '')}
          disabled={betBusy}
          onClick={() => onPick({
            marketAddress: active.address as Address,
            feedId: active.feedId,
            symbol,
            durationSec: active.duration,
            side: 'down',
            oddsPct: 0,
          })}
        >
          <span className="side"><Chev dir="down" /> DOWN</span>
          <MarketQueue market={active} side="down" />
        </button>
      </div>
    </div>
  )
}
