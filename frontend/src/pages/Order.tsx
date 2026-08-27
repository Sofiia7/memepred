/**
 * Order page — Sprint 4.4
 *
 * /order/:address/:orderId
 * Status card + claim/refund actions for a single order.
 */
import { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useWriteContract } from 'wagmi'
import type { Address } from 'viem'
import { ORDERBOOK_MARKET_ABI } from '../lib/contracts'
import { useClaim } from '../hooks/useClaim'
import { useEnsureChain } from '../hooks/useEnsureChain'
import { OrderStatusCard } from '../components/OrderStatusCard'
import { ScreenTitle } from '../components/ui/AppShell'

export function OrderPage() {
  const params = useParams<{ address: string; orderId: string }>()
  const navigate = useNavigate()

  const marketAddress = (params.address ?? '') as Address
  const orderId = (() => {
    try { return BigInt(params.orderId ?? '0') } catch { return 0n }
  })()
  const isValidOrder = Boolean(marketAddress) && orderId !== 0n

  // Hooks must run unconditionally on every render — React Router doesn't
  // remount OrderPage across param changes on the same route, so an early
  // return before these (as this page used to have) changes the hook count
  // between renders and crashes with "Rendered fewer hooks than expected"
  // the moment a user navigates between two /order/:address/:orderId URLs.
  const { claim, pending: claimPending, error: claimError } = useClaim(marketAddress)
  const { writeContractAsync: refundExpired } = useWriteContract()
  const ensureChain = useEnsureChain()
  const [refundPending, setRefundPending] = useState(false)
  const [refundError, setRefundError] = useState<string>()

  if (!isValidOrder) {
    return (
      <>
        <ScreenTitle title="Order not found" />
        <Link to="/" className="cta">Back to markets</Link>
      </>
    )
  }

  async function handleRefund() {
    setRefundError(undefined)
    setRefundPending(true)
    try {
      const chainCheck = await ensureChain()
      if (!chainCheck.ok) { setRefundError(chainCheck.error); return }
      await refundExpired({
        address: marketAddress,
        abi: ORDERBOOK_MARKET_ABI,
        functionName: 'refundExpired',
        args: [orderId],
      })
    } catch (e: any) {
      setRefundError(e?.shortMessage || e?.message || 'Refund failed')
    } finally {
      setRefundPending(false)
    }
  }

  /**
   * Recover a stake from a match the keeper never settled.
   *
   * Past settleAt + SETTLE_GRACE (24h) the contract refuses to settle at all —
   * resolveOrderbookMarketBatch reverts with "settlement window expired" — and
   * emergencyRefundMatch becomes the only way to get the money out. It is
   * permissionless by design, but nothing in the app ever called it: the ABI
   * entry existed and had no caller, so a keeper outage longer than a day left
   * users staring at "Awaiting market settlement…" forever with their funds
   * recoverable only by hand-crafting a call on Basescan.
   */
  async function handleEmergencyRefund(matchId: bigint) {
    setRefundError(undefined)
    setRefundPending(true)
    try {
      const chainCheck = await ensureChain()
      if (!chainCheck.ok) { setRefundError(chainCheck.error); return }
      await refundExpired({
        address: marketAddress,
        abi: ORDERBOOK_MARKET_ABI,
        functionName: 'emergencyRefundMatch',
        args: [matchId],
      })
    } catch (e: any) {
      setRefundError(e?.shortMessage || e?.message || 'Recovery failed')
    } finally {
      setRefundPending(false)
    }
  }

  return (
    <>
      <ScreenTitle title={`Order #${orderId.toString()}`} />

      <OrderStatusCard
        marketAddress={marketAddress}
        orderId={orderId}
        onClaim={() => claim(orderId)}
        onRefund={handleRefund}
        onEmergencyRefund={handleEmergencyRefund}
        txPending={claimPending || refundPending}
      />

      {(claimError || refundError) && (
        <div className="osc-error">{claimError || refundError}</div>
      )}

      <div style={{ marginTop: 16 }}>
        <button
          className="cta"
          onClick={() => navigate(`/market/${marketAddress}`)}
        >
          Back to market
        </button>
      </div>
    </>
  )
}
