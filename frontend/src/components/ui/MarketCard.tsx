import { useState, useMemo } from 'react'
import type { Address } from 'viem'
import type { Market } from '../../hooks/useMarkets'
import { useOdds } from '../../hooks/useOdds'
import { useNow, countdownFrom } from '../../hooks/useNow'
import { symbolMeta, formatPrice, formatDuration } from '../../lib/symbols'
import { Chev } from './icons'

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
  livePrice?: number
  chg24h?: number
  markets: Market[]                 // all open markets for this symbol (different durations)
  picked: PickedBet | null
  onPick: (b: PickedBet) => void
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function MarketOdds({ market, side }: { market: Market; side: 'up' | 'down' }) {
  const { probUp } = useOdds(market.address as Address)
  const pct = side === 'up' ? probUp : 1 - probUp
  return <span className="pct">{Math.round(pct * 100)}%</span>
}

export function MarketCardUI({ symbol, livePrice = 0, chg24h = 0, markets, picked, onPick }: Props) {
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
  const { probUp } = useOdds((active?.address ?? ZERO_ADDRESS) as Address)
  if (!active) return null
  const isSelHere = picked?.marketAddress.toLowerCase() === active.address.toLowerCase()

  return (
    <div className="market">
      <div className="coin">
        <div className="coin-l">
          <div className={'coin-icon ' + meta.iconClass}>{meta.glyph}</div>
          <div>
            <div className="coin-name">{symbol}<span className="pair"> / USD</span></div>
            <div className="coin-sub">{meta.name}</div>
          </div>
        </div>
        <div className="coin-r">
          <div className="coin-price">${formatPrice(livePrice)}</div>
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
            <span className="tf-end">⌁ {countdownFrom(m.closeTime, now)}</span>
          </button>
        ))}
      </div>

      <div className="ud">
        <button
          className={'b b-up ' + (isSelHere && picked?.side === 'up' ? 'sel' : '')}
          onClick={() => onPick({
            marketAddress: active.address as Address,
            feedId: active.feedId,
            symbol,
            durationSec: active.duration,
            side: 'up',
            oddsPct: Math.round(probUp * 100),
          })}
        >
          <span className="side"><Chev dir="up" /> UP</span>
          <MarketOdds market={active} side="up" />
        </button>
        <button
          className={'b b-dn ' + (isSelHere && picked?.side === 'down' ? 'sel' : '')}
          onClick={() => onPick({
            marketAddress: active.address as Address,
            feedId: active.feedId,
            symbol,
            durationSec: active.duration,
            side: 'down',
            oddsPct: Math.round((1 - probUp) * 100),
          })}
        >
          <span className="side"><Chev dir="down" /> DOWN</span>
          <MarketOdds market={active} side="down" />
        </button>
      </div>
    </div>
  )
}
