import type { MatchOutcome } from './orderModel'

const API = import.meta.env.VITE_API_URL

/** One match of an order, as GET /api/markets/:address/orders/:orderId serves it. */
export interface OrderApiMatch {
  matchId: string
  isLpMatch: boolean
  /** Whole currency units (WETH on Robinhood Chain), a parseFloat of NUMERIC. */
  amount: number
  settled: boolean
  settleAt: number
  outcome: MatchOutcome
}

/** The endpoint's whole body. `payout` is the accrued or, once claimed, the paid amount. */
export interface OrderApiRecord {
  orderId: string
  trader: string
  direction: 'UP' | 'DOWN'
  amount: number
  filledAmount: number
  status: string
  payout: number | null
  unmatchedRefunded: boolean
  matches: OrderApiMatch[]
}

/** A non-OK answer. `status` 404 means the backend has never seen this order. */
export class OrderApiError extends Error {
  constructor(readonly status: number) {
    super(`order api ${status}`)
    this.name = 'OrderApiError'
  }
}

export async function fetchOrderRecord(
  marketAddress: string,
  orderId: bigint,
  signal?: AbortSignal,
): Promise<OrderApiRecord> {
  const res = await fetch(`${API}/api/markets/${marketAddress}/orders/${orderId}`, { signal })
  if (!res.ok) throw new OrderApiError(res.status)
  return (await res.json()) as OrderApiRecord
}
