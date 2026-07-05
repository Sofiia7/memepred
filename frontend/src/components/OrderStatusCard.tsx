/**
 * OrderStatusCard — Sprint 4.3
 *
 * Single source of truth for order status visualization. Renders the four
 * lifecycle states (pending → matched → settled → refunded) with the right
 * affordances:
 *
 *   pending    — show countdown to MATCH_TIMEOUT (5 min). Allow refund if expired.
 *   matched    — show "result in <duration>" countdown.
 *   settled    — show win/loss + payout. If payout > 0, allow Claim.
 *   claimed    — show "claimed"
 *   refunded   — show "refunded"
 *
 * Reads order state via useOrderStatus + getOrder.
 */
import { useReadContract } from 'wagmi'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { formatUnits } from 'viem'
import { ORDERBOOK_MARKET_ABI } from '../lib/contracts'
import { useOrderStatus } from '../hooks/useOrderStatus'
import { ShareCard } from './ShareCard'

interface Props {
  marketAddress: Address
  orderId:       bigint
  onClaim?:      () => void
  onRefund?:     () => void
  txPending?:    boolean
}

function fmt(seconds: number): string {
  if (seconds <= 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function OrderStatusCard({
  marketAddress,
  orderId,
  onClaim,
  onRefund,
  txPending,
}: Props) {
  const { status, secondsLeft, isLpMatch, refetch } = useOrderStatus(marketAddress, orderId)

  // Re-read order details (full struct, including filled & unmatchedRefunded).
  const { data: order } = useReadContract({
    address: marketAddress,
    abi: ORDERBOOK_MARKET_ABI,
    functionName: 'getOrder',
    args: [orderId],
    query: { enabled: orderId > 0n, refetchInterval: 5_000 },
  })

  // Countdown to settlement (only when MATCHED).
  const [now, setNow] = useState(Math.floor(Date.now() / 1000))
  useEffect(() => {
    if (status !== 'matched' && status !== 'pending') return
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [status])

  if (!order) {
    return <div className="osc osc-loading">Loading order…</div>
  }

  const amount       = order.amount
  const filled       = order.filledAmount
  const payout       = order.payout
  const placedAt     = Number(order.placedAt)
  const unmatchedRef = order.unmatchedRefunded
  const dir          = order.direction === 0 ? 'UP' : 'DOWN'

  const amountUsd = formatUnits(amount, 6)
  const filledUsd = formatUnits(filled, 6)
  const payoutUsd = formatUnits(payout, 6)
  const won       = payout > 0n

  // ── PENDING ────────────────────────────────────────────────
  if (status === 'pending') {
    const expiresAt = placedAt + 300 // MATCH_TIMEOUT = 5 min
    const left = Math.max(0, expiresAt - now)
    const expired = left === 0
    return (
      <div className="osc osc-pending">
        <div className="osc-head">🔍 Searching for a match…</div>
        <div className="osc-meta">
          {dir} · ${amountUsd}
          {filled > 0n && ` (filled $${filledUsd} so far)`}
        </div>
        <div className="osc-timer">
          {expired ? 'Match window expired' : `${fmt(left)} until refund window opens`}
        </div>
        {expired && !unmatchedRef && (
          <button className="osc-btn" disabled={txPending} onClick={onRefund}>
            {txPending ? 'Processing…' : 'Refund unmatched portion'}
          </button>
        )}
      </div>
    )
  }

  // ── MATCHED ────────────────────────────────────────────────
  if (status === 'matched') {
    return (
      <div className="osc osc-matched">
        <div className="osc-head">{isLpMatch ? '🏦 Matched with LP pool' : '⚡ Matched'}</div>
        <div className="osc-meta">
          {dir} · ${filledUsd} at risk
          {filled < amount && ` (partial fill — $${amountUsd} deposit)`}
        </div>
        <div className="osc-sub">Awaiting market settlement…</div>
      </div>
    )
  }

  // ── SETTLED ────────────────────────────────────────────────
  if (status === 'settled') {
    return (
      <div className={`osc ${won ? 'osc-won' : 'osc-lost'}`}>
        <div className="osc-head">{won ? '🎉 You won' : 'Loss — better luck next time'}</div>
        <div className="osc-meta">
          {dir} · ${filledUsd} at risk · payout ${payoutUsd}
        </div>
        {won && (
          <button className="osc-btn osc-claim" disabled={txPending} onClick={onClaim}>
            {txPending ? 'Processing…' : `Claim $${payoutUsd}`}
          </button>
        )}
        {won && <ShareCard direction={dir} amountUsd={filledUsd} payoutUsd={payoutUsd} />}
      </div>
    )
  }

  // ── CLAIMED ────────────────────────────────────────────────
  if (status === 'claimed') {
    return (
      <div className="osc osc-claimed">
        <div className="osc-head">✓ Claimed</div>
        <div className="osc-meta">{dir} · received ${payoutUsd}</div>
        <ShareCard direction={dir} amountUsd={filledUsd} payoutUsd={payoutUsd} />
      </div>
    )
  }

  // ── REFUNDED ───────────────────────────────────────────────
  return (
    <div className="osc osc-refunded">
      <div className="osc-head">↩ Refunded</div>
      <div className="osc-meta">{dir} · ${amountUsd} returned</div>
    </div>
  )
}
