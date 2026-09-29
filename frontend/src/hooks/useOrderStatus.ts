import { useReadContract, useWatchContractEvent, usePublicClient } from 'wagmi'
import { useCallback, useEffect, useRef, useState } from 'react'
import { parseAbiItem, type Address } from 'viem'
import { CURRENCY_DECIMALS, ORDERBOOK_MARKET_ABI } from '../lib/contracts'
import { numberToUnits, ORDER_STATUS } from '../lib/orderModel'
import { orderKey, useOrderMatches } from './useOrderMatches'

export type OrderStatusType = 'pending' | 'matched' | 'settled' | 'claimed' | 'refunded'

/** OrderbookMarket.OrderStatus, by ordinal. */
const STATUS_NAMES: OrderStatusType[] = ['pending', 'matched', 'settled', 'claimed', 'refunded']

const CLAIMED_EVENT = parseAbiItem('event Claimed(uint256 indexed orderId, address trader, uint256 payout)')

/**
 * The amount a CLAIMED order actually paid, read from its Claimed log.
 *
 * claim() zeroes order.payout on chain before it transfers, so once an order is
 * CLAIMED the chain no longer says what it paid - only the event does. This is
 * the last resort behind the live read, the value captured earlier in this
 * session and the backend's stored payout, for a reload while the API is down.
 * Best effort by nature: a public RPC may refuse a wide getLogs range, and then
 * the amount simply stays unknown rather than being shown as zero.
 */
function useClaimedLogPayout(marketAddress: Address, orderId: bigint, enabled: boolean): bigint | undefined {
  const client = usePublicClient()
  const key = orderKey(marketAddress, orderId)
  const [found, setFound] = useState<{ key: string; value: bigint } | undefined>()

  useEffect(() => {
    if (!enabled || !client || orderId <= 0n) return
    let cancelled = false
    client
      .getLogs({
        address: marketAddress,
        event: CLAIMED_EVENT,
        args: { orderId },
        fromBlock: 'earliest',
        toBlock: 'latest',
      })
      .then((logs) => {
        const last = logs[logs.length - 1]
        const paid = last?.args?.payout
        if (!cancelled && paid !== undefined) setFound({ key, value: paid })
      })
      .catch(() => {
        /* range refused or RPC down: leave the amount unknown */
      })
    return () => {
      cancelled = true
    }
  }, [enabled, client, marketAddress, orderId, key])

  return found?.key === key ? found.value : undefined
}

/**
 * Track one order: the chain's view of it (getOrder / getMatch, polled), the
 * backend's per-match breakdown, and the amount it paid.
 *
 * Everything here is derived from those reads or keyed by (market, orderId).
 * The old version held `status`, the captured payout and the LP flag in plain
 * useState: React Router does not remount across param changes, so one order's
 * payout leaked into the next order's card, and after a reload a claimed order
 * read "received 0" because the chain had zeroed it and nothing else remembered.
 */
export function useOrderStatus(marketAddress: Address, orderId: bigint) {
  const key = orderKey(marketAddress, orderId)

  // Read order from contract. Polled: nothing else pushes a change to a page
  // that is just sitting open, and the event watcher below only speeds it up.
  const {
    data: order,
    refetch: refetchOrder,
    isLoading: orderLoading,
    isError: orderError,
  } = useReadContract({
    address:      marketAddress,
    abi:          ORDERBOOK_MARKET_ABI,
    functionName: 'getOrder',
    args:         [orderId],
    query: {
      enabled: orderId > 0n,
      refetchInterval: (query) => {
        const s = query.state.data?.status
        return s === ORDER_STATUS.CLAIMED ? false : 5_000
      },
    },
  })

  // The FIRST match this order belongs to, for its settleAt and entry/exit
  // price. Read rather than held: settleAt used to be useState with no setter
  // anywhere, so it was undefined forever and the 24h "recover my stake" button
  // could never appear. Derived values have no setter to forget.
  const matchId = order?.matchId ?? 0n
  const { data: match, refetch: refetchMatch } = useReadContract({
    address:      marketAddress,
    abi:          ORDERBOOK_MARKET_ABI,
    functionName: 'getMatch',
    args:         [matchId],
    query:        { enabled: matchId > 0n, refetchInterval: 5_000 },
  })

  // Every match, from the backend: what a single getMatch(order.matchId)
  // cannot see (audit A04) and the paid amount after a reload.
  const {
    matches,
    payout: apiPayout,
    isLoading: matchesLoading,
    isError: matchesError,
    refetch: refetchMatches,
  } = useOrderMatches(marketAddress, orderId)

  function refetchAll() {
    void refetchOrder()
    void refetchMatch()
    void refetchMatches()
  }

  // One watcher for the whole market, filtered here. Seven per-event watchers
  // are seven filters polled every few seconds for a page that shows one order.
  // The old MatchSettled watcher compared against order.matchId alone and so
  // missed every match of a multi-fill order but the first; the filter below
  // knows all of this order's matches. Whatever it misses (an indexer that is
  // behind on a later match) the 5 second poll picks up.
  //
  // The callback handed to wagmi has to be STABLE: useWatchContractEvent lists
  // onLogs in its effect's dependencies, so an inline lambda tears the filter
  // down and installs a new one on every render - and a card that ticks a
  // countdown re-renders every second. The latest closure lives in a ref.
  const knownMatchIds = new Set<string>([...matches.map((m) => m.matchId), matchId.toString()])
  const onLogsRef = useRef<(logs: readonly unknown[]) => void>(() => {})
  onLogsRef.current = (logs) => {
    for (const log of logs) {
      const args = (log as { args?: Record<string, unknown> }).args ?? {}
      const name = (log as { eventName?: string }).eventName
      const mine =
        name === 'OrderMatched'  ? args.upId === orderId || args.downId === orderId :
        name === 'LPMatched'     ? args.orderId === orderId :
        name === 'OrderRefunded' ? args.orderId === orderId :
        name === 'Claimed'       ? args.orderId === orderId :
        name === 'MatchSettled' || name === 'MatchTied' || name === 'MatchRefunded'
          ? knownMatchIds.has(String(args.matchId))
          : false
      if (mine) {
        refetchAll()
        return
      }
    }
  }
  const onLogs = useCallback((logs: readonly unknown[]) => onLogsRef.current(logs), [])
  useWatchContractEvent({
    address: marketAddress,
    abi:     ORDERBOOK_MARKET_ABI,
    enabled: orderId > 0n,
    onLogs,
  })

  const settleAt = match ? Number(match.settleAt) : undefined

  // A match settling exactly at its entry price refunds both sides
  // (OrderbookMarket._refundTiedMatch) rather than ever going to DOWN. It
  // never touches Order.payout - the refund happens inline in the settle
  // transaction, not staged for claim() - so `won = payout > 0n` alone reads
  // a tie as a loss. `settled` guards the zero/zero coincidence before a
  // price ever lands: entryPrice is always > 0 (placeBet requires it) but
  // exitPrice starts at 0 until settleMatch sets it.
  //
  // Scoped to this order's FIRST match only (order.matchId / `match` above).
  // It is the fallback for when the per-match list is unavailable; the card
  // prefers the aggregate over `matches`.
  const isTied = !!match && match.settled && match.exitPrice === match.entryPrice

  // The payout, in the order the sources can be trusted:
  //  1. the live read, while it is still there (before claim zeroes it);
  //  2. the last nonzero live read of THIS order in this session;
  //  3. what the backend stored for it (survives a reload);
  //  4. the Claimed log (survives the backend being down).
  // Undefined means "not known", which a claimed order must show as unknown and
  // never as zero.
  const livePayout = order?.payout ?? 0n
  const [captured, setCaptured] = useState<{ key: string; value: bigint } | undefined>()
  useEffect(() => {
    if (order && order.payout > 0n) setCaptured({ key, value: order.payout })
  }, [order, key])
  const capturedPayout = captured?.key === key ? captured.value : undefined

  const apiPayoutUnits = apiPayout !== null && apiPayout > 0 ? numberToUnits(apiPayout, CURRENCY_DECIMALS) : undefined

  const claimed = order?.status === ORDER_STATUS.CLAIMED
  const needsLog = claimed && livePayout === 0n && capturedPayout === undefined && apiPayoutUnits === undefined && !matchesLoading
  const logPayout = useClaimedLogPayout(marketAddress, orderId, needsLog)

  const payout = livePayout > 0n ? livePayout : capturedPayout ?? apiPayoutUnits ?? logPayout

  return {
    /** getOrder(orderId); undefined until it has loaded, or if the read failed. */
    order,
    isLoading: orderLoading,
    isError: orderError,
    status: STATUS_NAMES[order?.status ?? 0] ?? 'pending',
    /** Match deadline, so callers can tell an overdue match from a lost one. */
    settleAt,
    payout,
    /** From the chain, not from an event: an event flag is gone after a reload. */
    isLpMatch: !!match?.lpMatch,
    isTied,
    // Needed to offer emergencyRefundMatch when settlement never happens -
    // that call takes a matchId, not an orderId.
    matchId: order?.matchId,
    match,
    matches,
    matchesLoading,
    matchesError,
    refetch: refetchAll,
  }
}
