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
  const { data: order, refetch } = useReadContract({
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
  const { data: match } = useReadContract({
    address:      marketAddress,
    abi:          ORDERBOOK_MARKET_ABI,
    functionName: 'getMatch',
    args:         [matchId],
    query:        { enabled: matchId > 0n }
  })

  const settleAt = match ? Number(match.settleAt) : undefined

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
          refetch()
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
          refetch()
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
            refetch()
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
    // Needed to offer emergencyRefundMatch when settlement never happens -
    // that call takes a matchId, not an orderId.
    matchId: order?.matchId,
    refetch
  }
}
