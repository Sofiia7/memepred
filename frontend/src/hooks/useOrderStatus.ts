import { useReadContract, useWatchContractEvent } from 'wagmi'
import { useState, useEffect } from 'react'
import { ORDERBOOK_MARKET_ABI } from '../lib/contracts'
import type { Address } from 'viem'

type OrderStatusType = 'pending' | 'matched' | 'settled' | 'claimed' | 'refunded'

/**
 * Track order status in real-time.
 * Shows user: searching for match → matched → result
 */
export function useOrderStatus(marketAddress: Address, orderId: bigint) {
  const [status, setStatus] = useState<OrderStatusType>('pending')
  const [payout,    setPayout]    = useState<bigint>()
  const [isLpMatch, setIsLpMatch] = useState(false)

  // Read order from contract
  const { data: order, refetch: refetchOrder } = useReadContract({
    address:      marketAddress,
    abi:          ORDERBOOK_MARKET_ABI,
    functionName: 'getOrder',
    args:         [orderId],
    query:        { enabled: orderId > 0n }
  })

  // The match this order belongs to, for its settleAt. Read rather than held:
  // settleAt used to be useState with no setter anywhere, so it was undefined
  // forever and the 24h "recover my stake" button could never appear. Derived
  // values have no setter to forget.
  const matchId = order?.matchId ?? 0n
  const { data: match, refetch: refetchMatch } = useReadContract({
    address:      marketAddress,
    abi:          ORDERBOOK_MARKET_ABI,
    functionName: 'getMatch',
    args:         [matchId],
    query:        { enabled: matchId > 0n }
  })

  // Neither read polls or watches blocks on its own - every event handler
  // below has always had to call refetch() itself to see the new state. The
  // settlement watchers only ever refetched `order`, never `match`, which
  // left `match` (entryPrice/exitPrice, settled, the tie check below) stuck
  // at its pre-settlement snapshot until something else remounted the
  // component. Harmless while nothing read match.settled for anything but the
  // receipt link; load-bearing now that a tie is detected from it live.
  function refetchAll() {
    refetchOrder()
    refetchMatch()
  }

  const settleAt = match ? Number(match.settleAt) : undefined

  // A match settling exactly at its entry price refunds both sides
  // (OrderbookMarket._refundTiedMatch) rather than ever going to DOWN. It
  // never touches Order.payout - the refund happens inline in the settle
  // transaction, not staged for claim() - so `won = payout > 0n` alone reads
  // a tie as a loss. `settled` guards the zero/zero coincidence before a
  // price ever lands: entryPrice is always > 0 (placeBet requires it) but
  // exitPrice starts at 0 until settleMatch sets it.
  //
  // Scoped to this order's FIRST match only (order.matchId / `match` above),
  // matching how the rest of this hook and OrderStatusCard already treat
  // multi-fill orders - see the struct comment on OrderbookMarket.Order.
  // A later match on the same order tying while an earlier one won or lost
  // would not be reflected here.
  const isTied = !!match && match.settled && match.exitPrice === match.entryPrice

  // Sync status from order data
  useEffect(() => {
    if (!order) return
    const statusMap: Record<number, OrderStatusType> = {
      0: 'pending',
      1: 'matched',
      2: 'settled',
      3: 'claimed',
      4: 'refunded'
    }
    setStatus(statusMap[order.status] ?? 'pending')
    if (order.payout > 0n) setPayout(order.payout)
  }, [order])

  // Listen for PvP match events
  useWatchContractEvent({
    address:   marketAddress,
    abi:       ORDERBOOK_MARKET_ABI,
    eventName: 'OrderMatched',
    onLogs: (logs) => {
      for (const log of logs) {
        const { upId, downId } = log.args as any
        if (upId === orderId || downId === orderId) {
          setStatus('matched')
          setIsLpMatch(false)
          refetchAll()
        }
      }
    }
  })

  // Listen for LP match events
  useWatchContractEvent({
    address:   marketAddress,
    abi:       ORDERBOOK_MARKET_ABI,
    eventName: 'LPMatched',
    onLogs: (logs) => {
      for (const log of logs) {
        if ((log.args as any).orderId === orderId) {
          setStatus('matched')
          setIsLpMatch(true)
          refetchAll()
        }
      }
    }
  })

  // Listen for settlement
  useWatchContractEvent({
    address:   marketAddress,
    abi:       ORDERBOOK_MARKET_ABI,
    eventName: 'MatchSettled',
    onLogs: (logs) => {
      if (order?.matchId) {
        for (const log of logs) {
          if ((log.args as any).matchId === order.matchId) {
            setStatus('settled')
            refetchAll()
          }
        }
      }
    }
  })

  // Listen for a tie. Also lands as 'settled' on the order's own status (see
  // isTied's comment above for why payout alone can't tell the two apart);
  // this only exists to refetch promptly while the page is open, the same
  // reason the MatchSettled watcher above does.
  useWatchContractEvent({
    address:   marketAddress,
    abi:       ORDERBOOK_MARKET_ABI,
    eventName: 'MatchTied',
    onLogs: (logs) => {
      if (order?.matchId) {
        for (const log of logs) {
          if ((log.args as any).matchId === order.matchId) {
            setStatus('settled')
            refetchAll()
          }
        }
      }
    }
  })

  return {
    status,
    /** Match deadline, so callers can tell an overdue match from a lost one. */
    settleAt,
    payout,
    isLpMatch,
    isTied,
    // Needed to offer emergencyRefundMatch when settlement never happens -
    // that call takes a matchId, not an orderId.
    matchId: order?.matchId,
    match,
    refetch: refetchAll
  }
}
