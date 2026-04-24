import { useMarkets } from '../hooks/useMarkets'
import { MarketCard } from '../components/MarketCard'

export function Markets() {
  const { data: markets, isLoading } = useMarkets()

  return (
    <div className="page">
      <h1 className="page-title">🎯 Live Markets</h1>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>
          Loading markets...
        </div>
      ) : !markets?.length ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>
          No markets available yet.
        </div>
      ) : (
        <div className="markets-grid">
          {markets.map(m => (
            <MarketCard
              key={m.address}
              market={m}
              onClick={() => {/* TODO: navigate to detail page */}}
            />
          ))}
        </div>
      )}
    </div>
  )
}
