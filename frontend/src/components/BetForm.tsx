import { useState } from 'react'
import { useAccount } from 'wagmi'
import { parseUnits, type Address } from 'viem'
import { usePlaceBet, type Direction } from '../hooks/usePlaceBet'
import { useOdds } from '../hooks/useOdds'

interface Props {
  marketAddress: Address
  /** Latest Pyth price (1e18-scaled) — pass from Market detail page. */
  pythPriceWei:  bigint
}

/**
 * Bet form: pick direction → enter USDC amount → submit.
 * Sends placeBet(dir, amount, referrer, expectedPrice, slippageBps).
 */
export function BetForm({ marketAddress, pythPriceWei }: Props) {
  const { isConnected } = useAccount()
  const [direction, setDirection]   = useState<Direction>(0)        // 0=UP
  const [amount, setAmount]         = useState('5')
  const [slippageBps, setSlippage]  = useState(100)                  // 1%
  const refCode = new URLSearchParams(window.location.search).get('ref') || undefined
  const referrer = refCode && refCode.startsWith('0x') && refCode.length === 42
    ? (refCode as Address)
    : undefined

  const { upDepth, downDepth, probUp } = useOdds(marketAddress)

  const { execute, step, error, isLoading, isConfirmed } = usePlaceBet({
    marketAddress,
    direction,
    amountUsd:     amount,
    referrer,
    expectedPrice: pythPriceWei,
    slippageBps
  })

  if (!isConnected) {
    return <div className="bet-form">Connect a wallet to place a bet.</div>
  }

  return (
    <div className="bet-form" style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button
          className={direction === 0 ? 'btn-primary' : 'btn-secondary'}
          style={{ flex: 1 }}
          onClick={() => setDirection(0)}
        >
          UP · {(probUp * 100).toFixed(0)}%
        </button>
        <button
          className={direction === 1 ? 'btn-primary' : 'btn-secondary'}
          style={{ flex: 1 }}
          onClick={() => setDirection(1)}
        >
          DOWN · {((1 - probUp) * 100).toFixed(0)}%
        </button>
      </div>

      <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>
        Amount (USDC, max 100)
      </label>
      <input
        type="number"
        min="1"
        max="100"
        step="1"
        value={amount}
        onChange={e => setAmount(e.target.value)}
        style={{ width: '100%', padding: 10, marginTop: 4, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)' }}
      />

      <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
        Slippage tolerance: {(slippageBps / 100).toFixed(2)}%
      </label>
      <input
        type="range"
        min="10" max="500" step="10"
        value={slippageBps}
        onChange={e => setSlippage(Number(e.target.value))}
        style={{ width: '100%' }}
      />

      <button
        className="btn-primary"
        style={{ width: '100%', marginTop: 14 }}
        disabled={isLoading || !pythPriceWei}
        onClick={execute}
      >
        {step === 'approving' && 'Approving USDC…'}
        {step === 'betting' && 'Placing bet…'}
        {step === 'confirmed' && 'Confirmed ✓'}
        {step === 'idle' && `Bet $${amount} ${direction === 0 ? 'UP' : 'DOWN'}`}
        {step === 'error' && 'Retry'}
      </button>

      {error && <div style={{ color: 'var(--accent2)', marginTop: 8, fontSize: 12 }}>{error}</div>}
      {isConfirmed && (
        <div style={{ color: 'var(--accent)', marginTop: 8, fontSize: 12 }}>
          Order placed — waiting for match.
        </div>
      )}

      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
        Queue depth: UP {Number(upDepth) / 1e6} USDC · DOWN {Number(downDepth) / 1e6} USDC
      </div>
    </div>
  )
}
