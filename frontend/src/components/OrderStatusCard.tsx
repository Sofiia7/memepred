/**
 * OrderStatusCard - Sprint 4.3, reworked for the 2026-09-29 fix pass.
 *
 * Single source of truth for order status visualization. What it renders comes
 * from the order's fields (lib/orderModel.ts), not from one enum:
 *
 *   searching - nothing matched yet. Cancel any time; refundable after 5 min.
 *   partial   - some matched, the rest still waits. Result countdown for the
 *               matched part, cancel for the rest, and why Claim is not open yet.
 *   running   - fully matched (or the tail came back). Countdown to the result,
 *               then "waiting for the keeper", then Recover after 24 hours.
 *   settled   - win / loss / tie / mixed, with Claim for the trader.
 *   claimed   - the amount actually paid, also after a reload.
 *   refunded  - stake returned, and why.
 *
 * Reads order state via useOrderStatus (getOrder / getMatch / the backend's
 * per-match breakdown). Actions are callbacks: the page owns the transactions.
 */
import { useAccount } from 'wagmi'
import { useEffect } from 'react'
import type { Address } from 'viem'
import { formatUnits } from 'viem'
import { CURRENCY_DECIMALS, CURRENCY_SYMBOL } from '../lib/contracts'
import { IS_POOL_BACKED } from '../lib/chain'
import { explorerAddressUrl } from '../lib/explorer'
import {
  aggregateOutcome,
  canCancelRemainder,
  canRefundExpired,
  claimBlocker,
  claimableNow,
  findStuckMatchId,
  formatCountdown,
  isOrderTrader,
  matchWindowLeft,
  mergeMatchTiming,
  MATCH_OUTCOME_LABEL,
  orderExists,
  orderPhase,
  REFUND_EXPLANATION,
  settlementMessage,
  settlementStatus,
  unmatchedRemainder,
  type MatchOutcome,
  type OrderOutcome,
} from '../lib/orderModel'
import { shortAddr } from '../lib/symbols'
import { useOrderStatus } from '../hooks/useOrderStatus'
import { useNow } from '../hooks/useNow'
import { ShareCard } from './ShareCard'
import '../order.css'

// Kept as exports: the audit A04 tests and older callers import them from here.
export { findStuckMatchId }

/** Only worth showing once there is more than one match to reconcile. */
export function MatchBreakdown({ matches }: { matches: { matchId: string; amount: number; outcome: MatchOutcome }[] }) {
  if (matches.length < 2) return null
  return (
    <div className="osc-sub osc-breakdown">
      Filled across {matches.length} matches:
      <ul>
        {matches.map((m) => (
          <li key={m.matchId}>
            {m.amount.toFixed(4)} {CURRENCY_SYMBOL} - {MATCH_OUTCOME_LABEL[m.outcome]}
          </li>
        ))}
      </ul>
      {matches.some((m) => m.outcome === 'emergency_refunded') && (
        <div className="osc-note">{REFUND_EXPLANATION}</div>
      )}
    </div>
  )
}

interface Props {
  marketAddress: Address
  orderId:       bigint
  /** claim(): the trader, once every match has settled and nothing is left waiting. */
  onClaim?:      () => void
  /** refundExpired(): anyone, once the 5-minute match window has closed. */
  onRefund?:     () => void
  /** cancelOrder(): the trader, at any time, for the unmatched remainder. */
  onCancel?:     () => void
  /** Called with the matchId once the 24h settlement grace period has lapsed. */
  onEmergencyRefund?: (matchId: bigint) => void
  txPending?:    boolean
  /** Change it to refetch everything, e.g. after a transaction was confirmed. */
  refreshSignal?: number
}

/** An order that has reached a result. 'open' is what the phase, not the outcome, says. */
type ClosedOutcome = Exclude<OrderOutcome, 'open'>

const OUTCOME_HEAD: Record<ClosedOutcome, string> = {
  win:      '🎉 You won',
  loss:     'Loss - better luck next time',
  tie:      '🤝 Tie - stake returned',
  mixed:    'Mixed result',
  refunded: '↩ Refunded (no price available)',
}

export function OrderStatusCard({
  marketAddress,
  orderId,
  onClaim,
  onRefund,
  onCancel,
  onEmergencyRefund,
  txPending,
  refreshSignal,
}: Props) {
  // While the wallet is reconnecting after a page load, `address` is undefined
  // for a moment: not the time to tell the trader to connect.
  const { address: account, isConnecting, isReconnecting } = useAccount()
  const walletSettling = !!(isConnecting || isReconnecting)
  const {
    order, isError, isLpMatch: lpOnChain, isTied, match, matchId, matches,
    payout: knownPayout, refetch,
  } = useOrderStatus(marketAddress, orderId)

  // Refetch on demand: a confirmed claim/cancel/refund has changed the chain and
  // nothing else says so until the next poll. Deliberately only on the signal.
  useEffect(() => {
    if (refreshSignal) refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal])

  // One clock for every countdown here. It only needs to be fast while
  // something is still waiting for a deadline.
  const active = !order || order.status <= 1 || order.pendingSettlements > 0n
  const now = useNow(active ? 1000 : 30_000)

  if (!order) {
    if (isError) {
      return (
        <div className="osc osc-notfound" role="alert">
          <div className="osc-head">Couldn't load this order</div>
          <div className="osc-sub">The network did not answer, or this is not a market address. Try again.</div>
          <button className="osc-btn" onClick={() => refetch()}>Retry</button>
        </div>
      )
    }
    return <div className="osc osc-loading">Loading order…</div>
  }

  // getOrder() of an id nobody used is a zeroed struct, not a revert. The page
  // shows "Order not found" with a way back before it ever renders this card;
  // this is the same guard for any other caller.
  if (!orderExists(order)) {
    return (
      <div className="osc osc-notfound" role="alert">
        <div className="osc-head">Order not found</div>
        <div className="osc-sub">There is no order #{orderId.toString()} on this market.</div>
      </div>
    )
  }

  const fmt = (v: bigint) => formatUnits(v, CURRENCY_DECIMALS)
  const amount    = order.amount
  const filled    = order.filledAmount
  const remainder = unmatchedRemainder(order)
  const dir       = order.direction === 0 ? 'UP' : 'DOWN'
  const amountStr    = fmt(amount)
  const filledStr    = fmt(filled)
  const remainderStr = fmt(remainder)
  // undefined = not known. A claimed order whose amount cannot be found says so
  // rather than "received 0": claim() zeroes order.payout before it transfers.
  const payoutStr = knownPayout !== undefined ? fmt(knownPayout) : undefined

  const phase       = orderPhase(order)
  const isTrader    = isOrderTrader(order, account)
  const canCancel   = canCancelRemainder(order, account)
  const canRefund   = canRefundExpired(order, now)
  const windowLeft  = matchWindowLeft(order, now)
  const windowOpen  = windowLeft > 0
  const claimable   = claimableNow(order)
  const blocker     = claimBlocker(order)
  const isLpMatch   = lpOnChain || matches.some((m) => m.isLpMatch)
  const explorerHref = explorerAddressUrl(marketAddress)

  // The per-match list, corrected by the chain for the one match the chain
  // hands us for free. Recover is only ever offered for a match that is
  // unsettled on chain AND past the grace: a settled match reverts "already
  // settled", which is what the old fallback (any lapsed grace, whether or not
  // the list had loaded and found nothing stuck) sent people to.
  const timing = mergeMatchTiming(
    matches,
    match && matchId !== undefined && matchId > 0n
      ? { matchId, settled: match.settled, settleAt: match.settleAt }
      : null,
  )
  const settlement = settlementStatus(timing, now)
  const settlementText = settlementMessage(settlement)
  const recoverableMatchId = settlement.kind === 'recoverable' ? BigInt(settlement.matchId) : undefined

  // One word for the whole order. The per-match list is what makes "mixed"
  // knowable; without it (API down, or an indexer still catching up and
  // calling a settled match open) the first match and the payout are all there
  // is, which is the pre-A04 behaviour and not a regression from it.
  const chainOutcome: ClosedOutcome = isTied ? 'tie' : (knownPayout ?? 0n) > 0n ? 'win' : 'loss'
  const apiOutcome = matches.length > 0 ? aggregateOutcome(matches.map((m) => m.outcome)) : undefined
  const outcome: ClosedOutcome = apiOutcome && apiOutcome !== 'open' ? apiOutcome : chainOutcome

  // ── Reusable pieces ───────────────────────────────────────
  const breakdown = <MatchBreakdown matches={matches} />

  const receipt = match && match.settled && match.exitPrice > 0n ? (
    <div className="osc-sub">
      {IS_POOL_BACKED && <>Entry {formatUnits(match.entryPrice, 18)} WETH/token · Exit {formatUnits(match.exitPrice, 18)} WETH/token · </>}
      {explorerHref && <a href={explorerHref} target="_blank" rel="noreferrer">View market receipt ↗</a>}
    </div>
  ) : null

  // Claim is the trader's call: claim() requires msg.sender to be the order's
  // trader, so offering it to whoever opened a shared link only produced a
  // revert. Shown only to the connected trader.
  const claimButton = claimable && isTrader && payoutStr !== undefined ? (
    <button className="osc-btn osc-claim" disabled={txPending} onClick={onClaim}>
      {txPending ? 'Processing…' : `Claim ${payoutStr} ${CURRENCY_SYMBOL}`}
    </button>
  ) : null

  // Winnings that cannot be claimed yet, and the one thing that would unlock them.
  const claimNotice =
    order.payout > 0n && blocker === 'open-remainder' ? (
      <div className="osc-sub osc-note">
        The matched part of this order won {fmt(order.payout)} {CURRENCY_SYMBOL}, but Claim is not available yet:
        part of your order is still waiting for a match. Cancel the remainder or wait for the automatic refund,
        then claim.
      </div>
    ) : order.payout > 0n && blocker === 'matches-running' ? (
      <div className="osc-sub osc-note">
        {fmt(order.payout)} {CURRENCY_SYMBOL} won so far. Claim opens once every match on this order has a result.
      </div>
    ) : null

  // Who this page is for. Claim, cancel and the payout belong to the trader.
  const viewerNote = !isTrader && !walletSettling ? (
    <div className="osc-sub">
      {account
        ? `Placed by ${shortAddr(order.trader)}. Only that wallet can claim or cancel this order.`
        : `Placed by ${shortAddr(order.trader)}. Connect that wallet to claim or cancel this order.`}
    </div>
  ) : null

  // Cancel is always available to the trader while something is unmatched; the
  // refund button is the permissionless route once the 5-minute window is over.
  const remainderActions = (
    <>
      {canCancel && onCancel && (
        <button className="osc-btn osc-btn-ghost" disabled={txPending} onClick={onCancel}>
          {txPending ? 'Processing…' : `Cancel remaining ${remainderStr} ${CURRENCY_SYMBOL}`}
        </button>
      )}
      {canRefund && onRefund && (
        <button className="osc-btn" disabled={txPending} onClick={onRefund}>
          {txPending ? 'Processing…' : 'Refund unmatched portion'}
        </button>
      )}
    </>
  )

  const windowLine = windowOpen
    ? `${formatCountdown(windowLeft)} until the match window closes`
    : 'Match window closed'

  // What is left to wait for on the matched part, and the way out if it never
  // arrives. `warn` styling once it is overdue.
  const settlementBlock = settlementText ? (
    <>
      <div className={settlement.kind === 'countdown' ? 'osc-timer' : 'osc-timer osc-warn'}>{settlementText.headline}</div>
      {settlementText.note && <div className="osc-sub">{settlementText.note}</div>}
      {settlementText.recover && <div className="osc-sub">{settlementText.recover}</div>}
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
    </>
  ) : null

  // ── SEARCHING ─────────────────────────────────────────────
  if (phase === 'searching') {
    return (
      <div className="osc osc-pending">
        <div className="osc-head">🔍 Searching for a match…</div>
        <div className="osc-meta">{dir} · {amountStr} {CURRENCY_SYMBOL}</div>
        <div className="osc-timer">{windowLine}</div>
        <div className="osc-sub">
          Nothing is lost while you wait. Cancel any time to get the full {amountStr} {CURRENCY_SYMBOL} back.
          After 5 minutes an unmatched order stops matching and is refunded automatically.
        </div>
        {remainderActions}
        {viewerNote}
      </div>
    )
  }

  // ── PARTLY MATCHED ────────────────────────────────────────
  if (phase === 'partial') {
    return (
      <div className="osc osc-pending">
        <div className="osc-head">⚡ Partly matched</div>
        <div className="osc-meta">
          {dir} · {filledStr} of {amountStr} {CURRENCY_SYMBOL} matched
        </div>
        {settlementBlock ?? (
          <div className="osc-sub">
            {order.pendingSettlements > 0n ? 'Awaiting the result of the matched part…' : 'The matched part has its result.'}
          </div>
        )}
        <div className="osc-meta">{remainderStr} {CURRENCY_SYMBOL} still waiting for a match</div>
        <div className="osc-timer">{windowLine}</div>
        <div className="osc-sub">
          Cancel the rest to get {remainderStr} {CURRENCY_SYMBOL} back now, or wait for the automatic refund.
          The matched part settles on its own either way.
        </div>
        {claimNotice}
        {remainderActions}
        {breakdown}
        {viewerNote}
      </div>
    )
  }

  // ── RUNNING (matched, waiting for the result) ─────────────
  if (phase === 'running') {
    return (
      <div className="osc osc-matched">
        <div className="osc-head">{isLpMatch ? '🏦 Matched with LP vault' : '⚡ Matched'}</div>
        <div className="osc-meta">
          {dir} · {filledStr} {CURRENCY_SYMBOL} at risk
          {filled < amount && ` (partial fill - ${fmt(amount - filled)} ${CURRENCY_SYMBOL} of the deposit went back to you)`}
        </div>
        {settlementBlock ?? (
          <div className="osc-sub">{claimable ? 'Every match has its result.' : 'Awaiting the result…'}</div>
        )}
        {settlement.kind === 'countdown' && (
          <div className="osc-sub">Settles on its own - nothing to do until then.</div>
        )}
        {/* Every match settled and the tail gone, but the contract has not
            promoted the status yet: claim() accepts exactly this (its
            "graceful" clause), so the button belongs here too. */}
        {claimButton}
        {claimNotice}
        {breakdown}
        {viewerNote}
      </div>
    )
  }

  // ── SETTLED ───────────────────────────────────────────────
  if (phase === 'settled') {
    // A match settling exactly at its entry price refunds both stakes
    // instead of paying either side (OrderbookMarket._refundTiedMatch) - it
    // never touches order.payout, so "payout > 0" alone reads this as a loss.
    // Refunded inline in the settle tx, not staged for claim(): nothing more to
    // do for that match. A later match on the same order can still have won or
    // lost independently, which is what `outcome` (all matches) tells apart.
    const head = OUTCOME_HEAD[outcome]
    const cls =
      outcome === 'win' ? 'osc-won' : outcome === 'tie' ? 'osc-tied' : outcome === 'mixed' || outcome === 'refunded' ? 'osc-mixed' : 'osc-lost'
    return (
      <div className={`osc ${cls}`}>
        <div className="osc-head">{head}</div>
        <div className="osc-meta">
          {outcome === 'tie'
            ? `${dir} · ${filledStr} ${CURRENCY_SYMBOL} refunded, no fee taken`
            : `${dir} · ${filledStr} ${CURRENCY_SYMBOL} at risk · payout ${payoutStr ?? '0'} ${CURRENCY_SYMBOL}`}
        </div>
        {outcome === 'refunded' && <div className="osc-sub">{REFUND_EXPLANATION}</div>}
        {claimButton}
        {claimNotice}
        {receipt}
        {breakdown}
        {isTrader && outcome === 'win' && payoutStr !== undefined && (
          <ShareCard direction={dir} amount={filledStr} payout={payoutStr} marketAddress={marketAddress} orderId={orderId} />
        )}
        {viewerNote}
      </div>
    )
  }

  // ── CLAIMED ───────────────────────────────────────────────
  if (phase === 'claimed') {
    return (
      <div className="osc osc-claimed">
        <div className="osc-head">✓ Claimed</div>
        <div className="osc-meta">
          {payoutStr !== undefined
            ? `${dir} · received ${payoutStr} ${CURRENCY_SYMBOL}`
            : `${dir} · payout amount unavailable right now`}
        </div>
        {payoutStr === undefined && (
          <div className="osc-sub">
            The contract clears the payout when it pays it out, and the paid amount could not be looked up
            just now. It is in the claim transaction on the explorer.
          </div>
        )}
        {receipt}
        {breakdown}
        {isTrader && payoutStr !== undefined && (
          <ShareCard direction={dir} amount={filledStr} payout={payoutStr} marketAddress={marketAddress} orderId={orderId} />
        )}
        {viewerNote}
      </div>
    )
  }

  // ── REFUNDED ──────────────────────────────────────────────
  // The contract forces status to REFUNDED whenever ANY one match on this order
  // is refunded, regardless of what its other matches did - a match won earlier
  // leaves a real, claimable payout that this branch has to be able to offer
  // (audit A04). With nothing ever matched it is simply a cancel or an expiry.
  const hadFill = filled > 0n
  const wonElsewhere = order.payout > 0n
  return (
    <div className="osc osc-refunded">
      <div className="osc-head">
        {!hadFill ? '↩ Refunded' : wonElsewhere ? '↩ Partly refunded' : '↩ Refunded (no price available)'}
      </div>
      <div className="osc-meta">{dir} · {amountStr} {CURRENCY_SYMBOL} returned</div>
      {!hadFill ? (
        <div className="osc-sub">No match was found for this order, so the whole stake went back to your wallet.</div>
      ) : (
        <div className="osc-sub">{REFUND_EXPLANATION}</div>
      )}
      {wonElsewhere && (
        <div className="osc-sub">
          A different match on this order won {fmt(order.payout)} {CURRENCY_SYMBOL} - that is still yours to claim.
        </div>
      )}
      {claimButton}
      {claimNotice}
      {receipt}
      {breakdown}
      {viewerNote}
    </div>
  )
}
