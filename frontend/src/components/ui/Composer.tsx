import { useState, useMemo, useEffect } from 'react'
import { useAccount } from 'wagmi'
import { useNavigate } from 'react-router-dom'
import { usePlaceBet } from '../../hooks/usePlaceBet'
import { usePythPrice } from '../../hooks/usePythPrice'
import { useConnectWallet } from '../../hooks/useConnectWallet'
import { formatDuration } from '../../lib/symbols'
import { MIN_BET, MAX_BET, CURRENCY_SYMBOL, LP_TAKER_FEE_BPS } from '../../lib/contracts'
import { Chev } from './icons'
import type { PickedBet } from './MarketCard'

const STAKE_CHIPS = [5, 10, 25, 100]

export function Composer({ picked, onClear }: { picked: PickedBet | null; onClear: () => void }) {
  const { isConnected } = useAccount()
  const { connectWallet } = useConnectWallet()
  const navigate = useNavigate()
  const [stake, setStake] = useState<number>(25)
  const { raw: pythRaw } = usePythPrice(picked?.feedId)

  const bet = usePlaceBet({
    marketAddress: (picked?.marketAddress ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
    direction: picked?.side === 'up' ? 0 : 1,
    amountUsd: String(stake),
    expectedPrice: pythRaw,
    slippageBps: 100,
  })

  // Redirect to the order-status page once the tx confirms and the orderId
  // has been decoded from the receipt. If for some reason the decode never
  // resolves (e.g. logs shape changed), fall back to just clearing after a
  // few seconds instead of leaving the composer stuck on "PLACED".
  useEffect(() => {
    if (!bet.isConfirmed || !picked) return
    if (bet.orderId !== undefined) {
      const marketAddress = picked.marketAddress
      const orderId = bet.orderId
      onClear()
      navigate(`/order/${marketAddress}/${orderId.toString()}`)
      return
    }
    const t = setTimeout(() => onClear(), 4000)
    return () => clearTimeout(t)
  }, [bet.isConfirmed, bet.orderId, picked, navigate, onClear])

  // Payout is a function of the matched stake, never of the queue-depth "lean"
  // shown on the UP/DOWN buttons - an odds-implied preview here once had users
  // expecting 3.3x on a 30% lean and getting 2x.
  //
  // Both ends, because the user cannot tell in advance which they will get.
  // A peer match pays the full 2x; if the LP pool took the other side, the 1%
  // taker fee comes off the winning pool and it pays 1.98x. Showing the 2x
  // alone overstated an LP-matched win by up to $2 at the 100 USDC cap, right
  // above a fee line that already said the 1% existed.
  const payout = useMemo(() => {
    if (!stake) return null
    const gross = stake * 2
    const net   = gross * (1 - LP_TAKER_FEE_BPS / 10_000)
    return { low: net.toFixed(2), high: gross.toFixed(2) }
  }, [stake])

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
          <span className="pick-tf">· {picked.oddsPct}% queue</span>
        </div>
        <button className="clear" onClick={onClear}>CLEAR</button>
      </div>

      <div className="stake-row">
        <div className="stake-input">
          <span className="ccy">$</span>
          <input
            type="number"
            value={stake}
            min={MIN_BET}
            max={MAX_BET}
            onChange={(e) => setStake(Math.min(MAX_BET, Math.max(0, +e.target.value || 0)))}
          />
        </div>
      </div>
      <div className="stake-hint">{MIN_BET}-{MAX_BET} {CURRENCY_SYMBOL} per bet</div>

      <div className="chips">
        {STAKE_CHIPS.map((c) => (
          <button key={c} className={'chip ' + (stake === c ? 'sel' : '')} onClick={() => setStake(c)}>
            ${c}
          </button>
        ))}
      </div>

      <button
        className={'cta' + (bet.isLoading ? ' disabled' : '')}
        disabled={bet.isLoading || stake < MIN_BET || stake > MAX_BET}
        onClick={() => {
          if (!isConnected) {
            connectWallet()
            return
          }
          bet.execute()
        }}
      >
        {bet.isLoading ? <span className="spinner" /> : <span className="basesq" />}
        {ctaText}
      </button>

      <div className="payout">
        <span>Fee: 0% peer match · 1% if matched by LP pool (win only)</span>
        <span>PAYOUT IF WON · <b>{payout ? `$${payout.low}-$${payout.high}` : '-'}</b></span>
      </div>
    </div>
  )
}
