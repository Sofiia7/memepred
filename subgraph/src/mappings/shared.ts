import { BigInt, Bytes, Address } from "@graphprotocol/graph-ts"
import { Trader, ProtocolStats } from "../../generated/schema"

export const ZERO_BI = BigInt.fromI32(0)
export const ONE_BI  = BigInt.fromI32(1)

export function getOrCreateTrader(addr: Bytes): Trader {
  let id = addr.toHexString()
  let t  = Trader.load(id)
  if (t == null) {
    t = new Trader(id)
    t.totalOrders       = ZERO_BI
    t.totalVolume       = ZERO_BI
    t.totalProfit       = ZERO_BI
    t.wonOrders         = ZERO_BI
    t.lostOrders        = ZERO_BI
    t.refundedOrders    = ZERO_BI
    t.currentStreak     = ZERO_BI
    t.maxStreak         = ZERO_BI
    t.referralCount     = ZERO_BI
    t.referralEarnings  = ZERO_BI
    t.save()

    let s = getStats()
    s.totalTraders = s.totalTraders.plus(ONE_BI)
    s.save()
  }
  return t as Trader
}

export function getStats(): ProtocolStats {
  let s = ProtocolStats.load("global")
  if (s == null) {
    s = new ProtocolStats("global")
    s.totalMarkets   = ZERO_BI
    s.totalOrders    = ZERO_BI
    s.totalMatches   = ZERO_BI
    s.totalVolume    = ZERO_BI
    s.totalFees      = ZERO_BI
    s.totalReferrals = ZERO_BI
    s.totalTraders   = ZERO_BI
    s.lastUpdated    = ZERO_BI
  }
  return s as ProtocolStats
}
