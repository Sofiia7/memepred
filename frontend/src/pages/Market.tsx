import { useParams, Link } from 'react-router-dom'
import { useReadContract } from 'wagmi'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { ORDERBOOK_MARKET_ABI } from '../lib/contracts'
import { BetForm } from '../components/BetForm'

const PYTH_HERMES = import.meta.env.VITE_PYTH_HERMES_URL ?? 'https://hermes.pyth.network'

export function Market() {
  const { address } = useParams<{ address: string }>()
  const marketAddress = address as Address

  const { data: pendingDepth } = useReadContract({
    address:      marketAddress,
    abi:          ORDERBOOK_MARKET_ABI,
    functionName: 'getPendingDepth',
    query:        { refetchInterval: 5_000 }
  })

  const { data: feedId } = useReadContract({
    address:      marketAddress,
    abi:          ORDERBOOK_MARKET_ABI,
    functionName: 'pythFeedId'
  })

  const { data: duration } = useReadContract({
    address:      marketAddress,
    abi:          ORDERBOOK_MARKET_ABI,
    functionName: 'duration'
  })

  const [pythPriceWei, setPythPriceWei] = useState<bigint>(0n)

  useEffect(() => {
    if (!feedId) return
    let cancelled = false
    const fetchPrice = async () => {
      try {
        const url = `${PYTH_HERMES}/v2/updates/price/latest?ids[]=${feedId}&encoding=hex&parsed=true`
        const r = await fetch(url)
        const j = await r.json()
        if (cancelled) return
        const p     = j.parsed?.[0]?.price
        if (!p) return
        const expo  = Number(p.expo)
        const price = BigInt(p.price)
        // normalize to 1e18
        const wei = expo < 0
          ? (price * 10n ** 18n) / (10n ** BigInt(-expo))
          : (price * 10n ** 18n) * (10n ** BigInt(expo))
        setPythPriceWei(wei)
      } catch (e) {
        console.warn('pyth fetch failed', e)
      }
    }
    fetchPrice()
    const i = setInterval(fetchPrice, 10_000)
    return () => { cancelled = true; clearInterval(i) }
  }, [feedId])

  if (!marketAddress) return <div style={{ padding: 24 }}>Invalid market address.</div>

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24, display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
      <div>
        <Link to="/">← Markets</Link>
        <h1 style={{ marginTop: 8 }}>Market</h1>
        <div className="stat-card">
          <div className="stat-label">Address</div>
          <div style={{ fontFamily: 'monospace', fontSize: 13 }}>{marketAddress}</div>
        </div>
        <div className="stats-grid" style={{ marginTop: 12 }}>
          <div className="stat-card">
            <div className="stat-value">
              {pythPriceWei > 0n ? (Number(pythPriceWei) / 1e18).toPrecision(6) : '—'}
            </div>
            <div className="stat-label">Live Pyth Price</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{duration ? Number(duration) / 60 : '—'} min</div>
            <div className="stat-label">Match Duration</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">
              {pendingDepth ? (Number(pendingDepth[0]) / 1e6).toFixed(2) : '0.00'}
            </div>
            <div className="stat-label">UP Queue (USDC)</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">
              {pendingDepth ? (Number(pendingDepth[1]) / 1e6).toFixed(2) : '0.00'}
            </div>
            <div className="stat-label">DOWN Queue (USDC)</div>
          </div>
        </div>

        <div style={{ marginTop: 24, fontSize: 13, color: 'var(--muted)' }}>
          Live chart: TBD (TradingView lightweight-charts).
        </div>
      </div>

      <BetForm marketAddress={marketAddress} pythPriceWei={pythPriceWei} />
    </div>
  )
}
