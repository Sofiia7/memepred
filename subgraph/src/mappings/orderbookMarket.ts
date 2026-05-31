import { BigInt, Bytes } from "@graphprotocol/graph-ts"
import {
  OrderPlaced,
  OrderMatched,
  LPMatched,
  OrderFilled,
  MatchSettled,
  OrderRefunded,
  Claimed
} from "../../generated/templates/OrderbookMarket/OrderbookMarket"
import { Market, Order, Match } from "../../generated/schema"
import { getOrCreateTrader, getStats, ZERO_BI, ONE_BI } from "./shared"

function orderId(market: string, orderIdBI: BigInt): string {
  return market + "-" + orderIdBI.toString()
}
function matchKey(market: string, matchIdBI: BigInt): string {
  return market + "-" + matchIdBI.toString()
}

export function handleOrderPlaced(ev: OrderPlaced): void {
  let mAddr = ev.address.toHexString()
  let m     = Market.load(mAddr)
  if (m == null) return
  m.totalOrders = m.totalOrders.plus(ONE_BI)
  m.save()

  let oid = orderId(mAddr, ev.params.orderId)
  let o   = new Order(oid)
  o.market    = mAddr
  o.orderId   = ev.params.orderId
  o.trader    = ev.params.trader
  o.direction = ev.params.dir == 0 ? "UP" : "DOWN"
  o.amount    = ev.params.amount
  o.referrer  = Bytes.empty()
  o.status    = "PENDING"
  o.placedAt  = ev.block.timestamp
  o.txPlace   = ev.transaction.hash
  o.save()

  let t = getOrCreateTrader(ev.params.trader)
  t.totalOrders = t.totalOrders.plus(ONE_BI)
  t.totalVolume = t.totalVolume.plus(ev.params.amount)
  t.save()

  let s = getStats()
  s.totalOrders = s.totalOrders.plus(ONE_BI)
  s.totalVolume = s.totalVolume.plus(ev.params.amount)
  s.lastUpdated = ev.block.timestamp
  s.save()
}

export function handleOrderMatched(ev: OrderMatched): void {
  let mAddr = ev.address.toHexString()
  let mid   = matchKey(mAddr, ev.params.matchId)

  let market = Market.load(mAddr)
  let dur    = market != null ? market.duration : ZERO_BI

  let mt = new Match(mid)
  mt.market     = mAddr
  mt.matchId    = ev.params.matchId
  mt.isLPMatch  = false
  mt.upOrder    = orderId(mAddr, ev.params.upId)
  mt.downOrder  = orderId(mAddr, ev.params.downId)
  mt.amount     = ev.params.amount                    // 3.5: real matched amount
  mt.entryPrice = ev.params.entryPrice
  mt.matchedAt  = ev.block.timestamp
  mt.settleAt   = ev.block.timestamp.plus(dur)        // 3.5: matchedAt + duration
  mt.settled    = false
  mt.save()

  // Orders may be partially filled — only flip status when OrderFilled fires.
  // Here we just record the match link as PRIMARY match (first one only).
  let up = Order.load(orderId(mAddr, ev.params.upId))
  if (up != null) {
    up.matchedAt = ev.block.timestamp
    if (up.match == null) up.match = mid
    up.save()
  }
  let dn = Order.load(orderId(mAddr, ev.params.downId))
  if (dn != null) {
    dn.matchedAt = ev.block.timestamp
    if (dn.match == null) dn.match = mid
    dn.save()
  }

  if (market != null) { market.totalMatches = market.totalMatches.plus(ONE_BI); market.save() }
  let s = getStats(); s.totalMatches = s.totalMatches.plus(ONE_BI); s.save()
}

export function handleLPMatched(ev: LPMatched): void {
  let mAddr = ev.address.toHexString()
  let mid   = matchKey(mAddr, ev.params.matchId)

  let market = Market.load(mAddr)
  let dur    = market != null ? market.duration : ZERO_BI

  let mt = new Match(mid)
  mt.market     = mAddr
  mt.matchId    = ev.params.matchId
  mt.isLPMatch  = true
  mt.lpOrder    = orderId(mAddr, ev.params.orderId)
  mt.amount     = ev.params.amount                    // 3.5: real matched amount
  mt.entryPrice = ev.params.entryPrice
  mt.matchedAt  = ev.block.timestamp
  mt.settleAt   = ev.block.timestamp.plus(dur)
  mt.settled    = false
  mt.save()

  let o = Order.load(orderId(mAddr, ev.params.orderId))
  if (o != null) {
    o.matchedAt = ev.block.timestamp
    if (o.match == null) o.match = mid
    o.save()
  }

  if (market != null) { market.totalMatches = market.totalMatches.plus(ONE_BI); market.save() }
  let s = getStats(); s.totalMatches = s.totalMatches.plus(ONE_BI); s.save()
}

/// Order is fully filled — only now flip status to MATCHED.
/// (Sprint 1.1: partial fills keep status PENDING until the last match.)
export function handleOrderFilled(ev: OrderFilled): void {
  let mAddr = ev.address.toHexString()
  let o = Order.load(orderId(mAddr, ev.params.orderId))
  if (o == null) return
  o.status = "MATCHED"
  o.save()
}

export function handleMatchSettled(ev: MatchSettled): void {
  let mAddr = ev.address.toHexString()
  let mid   = matchKey(mAddr, ev.params.matchId)

  let mt = Match.load(mid)
  if (mt == null) return
  mt.settled    = true
  mt.upWon      = ev.params.upWon
  mt.exitPrice  = ev.params.exit
  mt.settledAt  = ev.block.timestamp
  mt.save()
}

export function handleOrderRefunded(ev: OrderRefunded): void {
  let mAddr = ev.address.toHexString()
  let o = Order.load(orderId(mAddr, ev.params.orderId))
  if (o == null) return
  o.status     = "REFUNDED"
  o.refundedAt = ev.block.timestamp
  o.save()

  let t = getOrCreateTrader(ev.params.trader)
  t.refundedOrders = t.refundedOrders.plus(ONE_BI)
  t.save()
}

export function handleClaimed(ev: Claimed): void {
  let mAddr = ev.address.toHexString()
  let o = Order.load(orderId(mAddr, ev.params.orderId))
  if (o == null) return
  o.status    = "CLAIMED"
  o.claimedAt = ev.block.timestamp
  o.payout    = ev.params.payout
  o.save()

  let t = getOrCreateTrader(ev.params.trader)
  let profit = ev.params.payout.minus(o.amount)
  if (profit.gt(ZERO_BI)) t.totalProfit = t.totalProfit.plus(profit)
  t.wonOrders     = t.wonOrders.plus(ONE_BI)
  t.currentStreak = t.currentStreak.plus(ONE_BI)
  if (t.currentStreak.gt(t.maxStreak)) t.maxStreak = t.currentStreak
  t.save()
}
