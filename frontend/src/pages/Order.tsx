/**
 * Order page - Sprint 4.4, reworked for the 2026-09-29 fix pass.
 *
 * /order/:address/:orderId
 * Status card + claim / cancel / refund / recover actions for a single order.
 *
 * Three things changed from the original:
 *  - the route parameters are validated (viem isAddress, a positive integer id)
 *    before anything is read or signed, and a bad link says so;
 *  - an order that does not exist is "Order not found" with a way back, not a
 *    "Loading order..." that never ends;
 *  - every action follows its transaction to the receipt (hooks/useOrderActions),
 *    shows the wallet / submitted / confirmed / failed state with an explorer
 *    link, and refetches the order once it is mined.
 */
import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useReadContract } from 'wagmi'
import type { Address } from 'viem'
import { ORDERBOOK_MARKET_ABI } from '../lib/contracts'
import { orderExists } from '../lib/orderModel'
import { parseMarketParam, parseOrderIdParam } from '../lib/routeParams'
import { useOrderActions } from '../hooks/useOrderActions'
import { OrderStatusCard } from '../components/OrderStatusCard'
import { TxStatus } from '../components/TxStatus'
import { ScreenTitle } from '../components/ui/AppShell'

export function OrderPage() {
  const params = useParams<{ address: string; orderId: string }>()
  const market = parseMarketParam(params.address)
  const orderId = parseOrderIdParam(params.orderId)

  // No hooks below this line except through OrderView, which only ever gets
  // parameters that passed validation. Keyed by the order: React Router does not
  // remount a page across param changes, so without the key one order's
  // transaction status and refresh counter would follow the user to the next.
  if (!market || orderId === null) {
    return (
      <>
        <ScreenTitle title="Invalid order link" />
        <div className="empty-state">
          This link does not point at an order. Check the address and the order number, or open the
          order from your portfolio.
        </div>
        <Link to="/" className="cta">Back to markets</Link>
      </>
    )
  }
  return <OrderView key={`${market.toLowerCase()}:${orderId.toString()}`} marketAddress={market} orderId={orderId} />
}

function OrderView({ marketAddress, orderId }: { marketAddress: Address; orderId: bigint }) {
  // Bumped after each confirmed transaction: the card refetches on it.
  const [refreshSignal, setRefreshSignal] = useState(0)
  const actions = useOrderActions(marketAddress, {
    onConfirmed: () => setRefreshSignal((n) => n + 1),
  })

  // Whether the order exists at all. The same read the card makes, so react-query
  // serves both from one cache entry. getOrder() of an id nobody used is a zeroed
  // struct, not a revert, hence the zero-address check; an error that survives
  // react-query's retries is a wrong market address or an unreachable network.
  const { data: order, isError, refetch } = useReadContract({
    address: marketAddress,
    abi: ORDERBOOK_MARKET_ABI,
    functionName: 'getOrder',
    args: [orderId],
  })

  const missing = order !== undefined && !orderExists(order)
  const unreadable = isError && order === undefined

  if (missing || unreadable) {
    return (
      <>
        <ScreenTitle title="Order not found" />
        <div className="empty-state">
          {missing
            ? `There is no order #${orderId.toString()} on this market.`
            : "Couldn't read this order. The link may point at the wrong market, or the network is unreachable."}
        </div>
        {unreadable && (
          <button className="cta" style={{ marginBottom: 10 }} onClick={() => refetch()}>RETRY</button>
        )}
        <Link to="/" className="cta">Back to markets</Link>
      </>
    )
  }

  return (
    <>
      <ScreenTitle title={`Order #${orderId.toString()}`} />

      <OrderStatusCard
        marketAddress={marketAddress}
        orderId={orderId}
        onClaim={() => actions.claim(orderId)}
        onCancel={() => actions.cancel(orderId)}
        onRefund={() => actions.refundExpired(orderId)}
        // Past settleAt + 24h the contract no longer settles a match, and this
        // is the only way out. Permissionless by design, and it takes a MATCH id.
        onEmergencyRefund={(matchId) => actions.recover(matchId)}
        txPending={actions.isPending}
        refreshSignal={refreshSignal}
      />

      <TxStatus state={actions.state} />

      <div style={{ marginTop: 16 }}>
        <Link className="cta" to={`/market/${marketAddress}`}>
          Back to market
        </Link>
      </div>
    </>
  )
}
