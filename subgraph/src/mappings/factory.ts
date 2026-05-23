import { MarketCreated } from "../../generated/MarketFactory/MarketFactory"
import { OrderbookMarket } from "../../generated/templates"
import { Market } from "../../generated/schema"
import { getStats, ZERO_BI, ONE_BI } from "./shared"

export function handleMarketCreated(ev: MarketCreated): void {
  let id = ev.params.market.toHexString()
  let m  = new Market(id)
  m.feedId       = ev.params.feedId
  m.duration     = ev.params.duration
  m.createdAt    = ev.params.timestamp
  m.feeBps       = ZERO_BI
  m.totalOrders  = ZERO_BI
  m.totalMatches = ZERO_BI
  m.totalVolume  = ZERO_BI
  m.save()

  // Start indexing the new market.
  OrderbookMarket.create(ev.params.market)

  let s = getStats()
  s.totalMarkets = s.totalMarkets.plus(ONE_BI)
  s.lastUpdated  = ev.block.timestamp
  s.save()
}
