/**
 * OrderStatusCard - Sprint 4.3
 *
 * Single source of truth for order status visualization. Renders the four
 * lifecycle states (pending → matched → settled → refunded) with the right
 * affordances:
 *
 *   pending    - show countdown to MATCH_TIMEOUT (5 min). Allow refund if expired.
 *   matched    - show "result in <duration>" countdown.
 *   settled    - show win/loss + payout. If payout > 0, allow Claim.
 *   claimed    - show "claimed"
 *   refunded   - show "refunded"
 *
 * Reads order state via useOrderStatus + getOrder.
 */
import { useReadContract } from 'wagmi'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { formatUnits } from 'viem'
import { CURRENCY_DECIMALS, CURRENCY_SYMBOL } from '../lib/contracts'
import { IS_POOL_BACKED, TARGET_CHAIN } from '../lib/chain'
import { ORDERBOOK_MARKET_ABI, SETTLE_GRACE_SEC } from '../lib/contracts'
import { useOrderStatus } from '../hooks/useOrderStatus'
import { useOrderMatches, type MatchOutcome } from '../hooks/useOrderMatches'
import { ShareCard } from './ShareCard'

const OUTCOME_LABEL: Record<MatchOutcome, string> = {
  pending:            'awaiting settlement',
  won:                'won',
  lost:               'lost',
  tied:               'tied - refunded',
  emergency_refunded: 'emergency refunded',
}

/**
 * Which of an order's matches is actually stuck past SETTLE_GRACE, if any.
 * Exported for testing; see its call site's comment (audit A04, 2026-09-28)
 * for the bug this replaces - always offering to recover order.matchId, the
 * FIRST match, even once a LATER one is the one that is actually overdue.
 */
export function findStuckMatchId(
  matches: { matchId: string; settled: boolean; settleAt: number }[],
  nowUnixSec: number,
): bigint | undefined {
  const stuck = matches.find((m) => !m.settled && nowUnixSec > m.settleAt + SETTLE_GRACE_SEC)
  return stuck ? BigInt(stuck.matchId) : undefined
}

/** Only worth showing once there is more than one match to reconcile. */
export function MatchBreakdown({ matches }: { matches: { matchId: string; amount: number; outcome: MatchOutcome }[] }) {
  if (matches.length < 2) return null
  return (
    <div className="osc-sub osc-breakdown">
      Filled across {matches.length} matches:
      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
        {matches.map((m) => (
          <li key={m.matchId}>
            {m.amount.toFixed(4)} {CURRENCY_SYMBOL} - {OUTCOME_LABEL[m.outcome]}
          </li>
        ))}
      </ul>
    </div>
  )
}

interface Props {
  marketAddress: Address
  orderId:       bigint
  onClaim?:      () => void
  onRefund?:     () => void
  /** Called with the matchId once the 24h settlement grace period has lapsed. */
  onEmergencyRefund?: (matchId: bigint) => void
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
  onEmergencyRefund,
  txPending,
}: Props) {
  const { status, isLpMatch, isTied, settleAt, matchId, match, payout: capturedPayout } =
    useOrderStatus(marketAddress, orderId)

  // Re-read order details (full struct, including filled & unmatchedRefunded).
  const { data: order } = useReadContract({
    address: marketAddress,
    abi: ORDERBOOK_MARKET_ABI,
    functionName: 'getOrder',
    args: [orderId],
    query: { enabled: orderId > 0n, refetchInterval: 5_000 },
  })

  // All of this order's matches, for the cases a single getMatch(order.matchId)
  // cannot see: a later match tying or winning while the first lost or tied,
  // and finding whichever match is actually stuck rather than assuming it is
  // always the first one (audit A04, 2026-09-28). Called unconditionally,
  // above every early return below - see Market.tsx's own comment on the
  // Rules-of-Hooks crash this pattern exists to avoid.
  const { matches } = useOrderMatches(marketAddress, orderId)

  // Countdown to settlement (only when MATCHED).
  const [now, setNow] = useState(Math.floor(Date.now() / 1000))
  useEffect(() => {
    if (status !== 'matched' && status !== 'pending') return
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [status])

  // Past settleAt + SETTLE_GRACE the contract will not settle this match at
  // all, so "awaiting settlement" stops being true and the stake has to be
  // recoverable from the UI. Reuses the countdown clock above.
  const graceLapsed = settleAt !== undefined && now > settleAt + SETTLE_GRACE_SEC

  if (!order) {
    return <div className="osc osc-loading">Loading order…</div>
  }

  const amount       = order.amount
  const filled       = order.filledAmount
  const placedAt     = Number(order.placedAt)
  const unmatchedRef = order.unmatchedRefunded
  const dir          = order.direction === 0 ? 'UP' : 'DOWN'

  // claim() zeroes order.payout on-chain BEFORE transferring (see
  // OrderbookMarket.sol's claim: `o.payout = 0` runs before
  // usdc.safeTransfer), so re-reading order.payout after a claim always shows
  // 0 - "received 0 WETH", "Just won 0 WETH" on ShareCard, which reads this
  // same value. useOrderStatus's own payout state only ever updates on a
  // NONZERO read (see its useEffect), so it holds the last real payout this
  // order had rather than the now-zeroed current one; prefer the live value
  // only while it is actually still there (pre-claim).
  const payout    = order.payout > 0n ? order.payout : (capturedPayout ?? 0n)
  const amountUsd = formatUnits(amount, CURRENCY_DECIMALS)
  const filledUsd = formatUnits(filled, CURRENCY_DECIMALS)
  const payoutUsd = formatUnits(payout, CURRENCY_DECIMALS)
  const won       = payout > 0n

  // Mirrors OrderbookMarket.claim()'s exact require chain, independent of
  // which lifecycle branch below is about to render. Audit A04 (2026-09-28):
  // a REFUNDED order - forced there by a DIFFERENT match on it being
  // emergency-refunded, regardless of this order's own fill state - can still
  // satisfy this; the old code never looked, because each branch below only
  // ever handled its own literal status and the REFUNDED one never checked
  // payout at all.
  const claimablePayout =
    order.pendingSettlements === 0n &&
    order.status !== 3 && // not already CLAIMED
    order.payout > 0n &&
    (order.status === 2 /* SETTLED */ || (order.filledAmount > 0n && (order.filledAmount === order.amount || order.unmatchedRefunded)))

  const breakdown = <MatchBreakdown matches={matches} />
  // Falls back to the single-match value from useOrderStatus when the
  // breakdown has not loaded yet (or the backend is unavailable) - the
  // pre-A04 behaviour, not a regression from it.
  const recoverableMatchId =
    findStuckMatchId(matches, now) ?? (graceLapsed && matchId !== undefined ? matchId : undefined)

  const explorerUrl = TARGET_CHAIN.blockExplorers?.default.url
  const receipt = match && match.settled ? (
    <div className="osc-sub">
      {IS_POOL_BACKED && <>Entry {formatUnits(match.entryPrice, 18)} WETH/token · Exit {formatUnits(match.exitPrice, 18)} WETH/token · </>}
      {explorerUrl && <a href={`${explorerUrl}/address/${marketAddress}`} target="_blank" rel="noreferrer">View market receipt ↗</a>}
    </div>
  ) : null

  // ── PENDING ────────────────────────────────────────────────
  if (status === 'pending') {
    const expiresAt = placedAt + 300 // MATCH_TIMEOUT = 5 min
    const left = Math.max(0, expiresAt - now)
    const expired = left === 0
    return (
      <div className="osc osc-pending">
        <div className="osc-head">🔍 Searching for a match…</div>
        <div className="osc-meta">
          {dir} · {amountUsd} {CURRENCY_SYMBOL}
          {filled > 0n && ` (filled ${filledUsd} ${CURRENCY_SYMBOL} so far)`}
        </div>
        <div className="osc-timer">
          {expired ? 'Match window expired' : `${fmt(left)} until refund window opens`}
        </div>
        {expired && !unmatchedRef && (
          <button className="osc-btn" disabled={txPending} onClick={onRefund}>
            {txPending ? 'Processing…' : 'Refund unmatched portion'}
          </button>
        )}
        {/* A filled portion can have already won and be fully claimable even
            while the remainder is still resting in the book (audit A04). */}
        {claimablePayout && (
          <button className="osc-btn osc-claim" disabled={txPending} onClick={onClaim}>
            {txPending ? 'Processing…' : `Claim ${payoutUsd} ${CURRENCY_SYMBOL}`}
          </button>
        )}
        {breakdown}
      </div>
    )
  }

  // ── MATCHED ────────────────────────────────────────────────
  if (status === 'matched') {
    return (
      <div className="osc osc-matched">
        <div className="osc-head">{isLpMatch ? '🏦 Matched with LP pool' : '⚡ Matched'}</div>
        <div className="osc-meta">
          {dir} · {filledUsd} {CURRENCY_SYMBOL} at risk
          {filled < amount && ` (partial fill - ${amountUsd} ${CURRENCY_SYMBOL} deposit)`}
        </div>
        <div className="osc-sub">
          {graceLapsed
            ? 'Settlement is overdue - the keeper never resolved this match.'
            : 'Awaiting market settlement…'}
        </div>
        {recoverableMatchId !== undefined && recoverableMatchId > 0n && onEmergencyRefund && (
          <>
            <button
              className="osc-btn"
              disabled={txPending}
              onClick={() => onEmergencyRefund(recoverableMatchId)}
            >
              {txPending ? 'Processing…' : 'Recover my stake'}
            </button>
            <div className="osc-sub">
              Returns your deposit. The market can no longer be settled, so
              neither side wins.
            </div>
          </>
        )}
        {breakdown}
      </div>
    )
  }

  // ── SETTLED ────────────────────────────────────────────────
  if (status === 'settled') {
    // A match settling exactly at its entry price refunds both stakes
    // instead of paying either side (OrderbookMarket._refundTiedMatch) - it
    // never touches order.payout, so `won` alone reads this as a loss.
    // Refunded inline in the settle tx, not staged for claim(): no Claim
    // button, nothing more for the user to do here.
    if (isTied) {
      return (
        <div className="osc osc-tied">
          <div className="osc-head">🤝 Tie - stake returned</div>
          <div className="osc-meta">
            {dir} · {filledUsd} {CURRENCY_SYMBOL} refunded, no fee taken
          </div>
          {/* A later match on this same order can still have won or lost
              independently of this one tying - see MatchBreakdown (audit A04). */}
          {claimablePayout && (
            <button className="osc-btn osc-claim" disabled={txPending} onClick={onClaim}>
              {txPending ? 'Processing…' : `Claim ${payoutUsd} ${CURRENCY_SYMBOL}`}
            </button>
          )}
          {receipt}
          {breakdown}
        </div>
      )
    }
    return (
      <div className={`osc ${won ? 'osc-won' : 'osc-lost'}`}>
        <div className="osc-head">{won ? '🎉 You won' : 'Loss - better luck next time'}</div>
        <div className="osc-meta">
          {dir} · {filledUsd} {CURRENCY_SYMBOL} at risk · payout {payoutUsd} {CURRENCY_SYMBOL}
        </div>
        {claimablePayout && (
          <button className="osc-btn osc-claim" disabled={txPending} onClick={onClaim}>
            {txPending ? 'Processing…' : `Claim ${payoutUsd} ${CURRENCY_SYMBOL}`}
          </button>
        )}
        {receipt}
        {breakdown}
        {won && <ShareCard direction={dir} amount={filledUsd} payout={payoutUsd} marketAddress={marketAddress} orderId={orderId} />}
      </div>
    )
  }

  // ── CLAIMED ────────────────────────────────────────────────
  if (status === 'claimed') {
    return (
      <div className="osc osc-claimed">
        <div className="osc-head">✓ Claimed</div>
        <div className="osc-meta">{dir} · received {payoutUsd} {CURRENCY_SYMBOL}</div>
        {receipt}
        {breakdown}
        <ShareCard direction={dir} amount={filledUsd} payout={payoutUsd} marketAddress={marketAddress} orderId={orderId} />
      </div>
    )
  }

  // ── REFUNDED ───────────────────────────────────────────────
  // Audit A04 (2026-09-28): the contract forces status to REFUNDED whenever
  // ANY one match on this order gets emergency-refunded, regardless of what
  // its other matches did - a won match settled earlier leaves a real,
  // claimable payout that this branch used to have no way to offer.
  return (
    <div className="osc osc-refunded">
      <div className="osc-head">↩ Refunded</div>
      <div className="osc-meta">{dir} · {amountUsd} {CURRENCY_SYMBOL} returned</div>
      {claimablePayout && (
        <>
          <div className="osc-sub">
            A different match on this order won {payoutUsd} {CURRENCY_SYMBOL} - that is still yours to claim.
          </div>
          <button className="osc-btn osc-claim" disabled={txPending} onClick={onClaim}>
            {txPending ? 'Processing…' : `Claim ${payoutUsd} ${CURRENCY_SYMBOL}`}
          </button>
        </>
      )}
      {receipt}
      {breakdown}
    </div>
  )
}
