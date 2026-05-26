import { useState, useMemo, useEffect } from 'react'
import { useAccount, useConnect } from 'wagmi'
import { usePlaceBet } from '../../hooks/usePlaceBet'
import { usePythPrice } from '../../hooks/usePythPrice'
import { formatDuration } from '../../lib/symbols'
import { Chev } from './icons'
import type { PickedBet } from './MarketCard'

const STAKE_CHIPS = [10, 25, 100, 500]

export function Composer({ picked, onClear }: { picked: PickedBet | null; onClear: () => void }) {
  const { isConnected } = useAccount()
  const { connect, connectors } = useConnect()
  const [stake, setStake] = useState<number>(25)
  const { raw: pythRaw } = usePythPrice(picked?.feedId)

  const bet = usePlaceBet({
    marketAddress: (picked?.marketAddress ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
    direction: picked?.side === 'up' ? 0 : 1,
    amountUsd: String(stake),
    expectedPrice: pythRaw,
    slippageBps: 100,
  })

  useEffect(() => {
    if (bet.isConfirmed) {
      setTimeout(() => onClear(), 1500)
    }
  }, [bet.isConfirmed, onClear])

  const payout = useMemo(() => {
    if (!picked || !stake || !picked.oddsPct) return null
    return (stake / (picked.oddsPct / 100)).toFixed(2)
  }, [picked, stake])

  if (!picked) {
    return (
      <div className="composer empty">
        <div className="composer-empty-txt">↑ Tap UP or DOWN to place a bet</div>
      </div>
    )
  }

  const ctaText = !isConnected
    ? 'CONNECT WALLET'
    : bet.step === 'approving' ? 'APPROVING USDC…'
    : bet.step === 'betting' ? 'PLACING BET…'
    : bet.step === 'confirmed' ? 'PLACED ✓'
    : bet.step === 'error' ? 'RETRY · ' + (bet.error?.slice(0, 30) ?? '')
    : `BUY ${picked.side.toUpperCase()} · $${stake}`

  return (
    <div className="composer">
      <div className="composer-head">
        <div className="composer-pick">
          <span className={'pick-pill ' + (picked.side === 'up' ? 'up' : 'dn')}>
            <Chev dir={picked.side === 'up' ? 'up' : 'down'} /> {picked.side.toUpperCase()}
          </span>
          <span className="pick-coin">{picked.symbol}</span>
          <span className="pick-tf">· {formatDuration(picked.durationSec)}</span>
          <span className="pick-tf">· {picked.oddsPct}¢</span>
        </div>
        <button className="clear" onClick={onClear}>CLEAR</button>
      </div>

      <div className="stake-row">
        <div className="stake-input">
          <span className="ccy">$</span>
          <input
            type="number"
            value={stake}
            min={1}
            onChange={(e) => setStake(Math.max(0, +e.target.value || 0))}
          />
        </div>
      </div>

      <div className="chips">
        {STAKE_CHIPS.map((c) => (
          <button key={c} className={'chip ' + (stake === c ? 'sel' : '')} onClick={() => setStake(c)}>
            ${c}
          </button>
        ))}
      </div>

      <button
        className={'cta' + (bet.isLoading ? ' disabled' : '')}
        disabled={bet.isLoading || stake < 1}
        onClick={() => {
          if (!isConnected) {
            connectors[0] && connect({ connector: connectors[0] })
            return
          }
          bet.execute()
        }}
      >
        {bet.isLoading ? <span className="spinner" /> : <span className="basesq" />}
        {ctaText}
      </button>

      <div className="payout">
        <span>FEE 0.30%</span>
        <span>PAYOUT · <b>${payout ?? '—'}</b></span>
      </div>
    </div>
  )
}
