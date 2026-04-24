import type { Market } from '../hooks/useMarkets'

interface Props {
  market: Market
  onClick: () => void
}

export function MarketCard({ market, onClick }: Props) {
  const total = market.upPool + market.downPool
  const upPct = total > 0 ? Math.round(market.upPool / total * 100) : 50
  const downPct = 100 - upPct

  const timeLeft = Math.max(0, market.closeTime - Math.floor(Date.now() / 1000))
  const minutes = Math.floor(timeLeft / 60)
  const seconds = timeLeft % 60

  const statusClass = market.status.toLowerCase()

  return (
    <div className="market-card fade-in" onClick={onClick} style={{ cursor: 'pointer' }}>
      <div className="market-card-header">
        <span className="market-card-symbol">{market.feedSymbol}/USD</span>
        <span className={`market-card-badge badge-${statusClass}`}>
          {market.status}
        </span>
      </div>

      {/* Price */}
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
        Entry: ${market.entryPrice < 0.001 ? market.entryPrice.toExponential(3) : market.entryPrice.toFixed(6)}
        {market.exitPrice && (
          <span style={{ marginLeft: 12 }}>
            Exit: ${market.exitPrice < 0.001 ? market.exitPrice.toExponential(3) : market.exitPrice.toFixed(6)}
          </span>
        )}
      </div>

      {/* Prob bar */}
      <div className="prob-bar">
        <div className="prob-up" style={{ width: `${upPct}%` }}>
          ↑ {upPct}%
        </div>
        <div className="prob-down" style={{ width: `${downPct}%` }}>
          ↓ {downPct}%
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#666' }}>
        <span>Pool: ${total.toFixed(2)}</span>
        <span>
          {market.status === 'OPEN' && timeLeft > 0
            ? `${minutes}m ${seconds}s left`
            : market.status === 'RESOLVED'
              ? market.upWon ? '↑ UP WON' : '↓ DOWN WON'
              : market.status
          }
        </span>
        <span>{Math.floor(market.duration / 60)}m</span>
      </div>
    </div>
  )
}
