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
import { OrderStatusCard } from '../components/OrderStatusCard'
import { ScreenTitle } from '../components/ui/AppShell'

export function OrderPage() {
  const params = useParams<{ address: string; orderId: string }>()
  const navigate = useNavigate()

  const marketAddress = (params.address ?? '') as Address
  const orderId = (() => {
    try { return BigInt(params.orderId ?? '0') } catch { return 0n }
  })()

  if (!marketAddress || orderId === 0n) {
    return (
      <>
        <ScreenTitle title="Order not found" />
        <Link to="/" className="cta">Back to markets</Link>
      </>
    )
  }

  const { claim, pending: claimPending, error: claimError } = useClaim(marketAddress)
  const { writeContractAsync: refundExpired } = useWriteContract()
  const [refundPending, setRefundPending] = useState(false)
  const [refundError, setRefundError] = useState<string>()

  async function handleRefund() {
    setRefundError(undefined)
    setRefundPending(true)
    try {
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

  return (
    <>
      <ScreenTitle title={`Order #${orderId.toString()}`} />

      <OrderStatusCard
        marketAddress={marketAddress}
        orderId={orderId}
        onClaim={() => claim(orderId)}
        onRefund={handleRefund}
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
