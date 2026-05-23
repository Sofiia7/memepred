import { BadgeEarned } from "../../generated/BadgeNFT/BadgeNFT"
import { TraderBadge } from "../../generated/schema"
import { getOrCreateTrader } from "./shared"

export function handleBadgeEarned(ev: BadgeEarned): void {
  let traderHex = ev.params.trader.toHexString()
  let id  = traderHex + "-" + ev.params.badgeId.toString()
  let tb  = new TraderBadge(id)
  tb.trader    = traderHex
  tb.badgeId   = ev.params.badgeId
  tb.badgeName = ev.params.badgeName
  tb.mintedAt  = ev.block.timestamp
  tb.tx        = ev.transaction.hash
  tb.save()

  // Touch trader so it exists.
  getOrCreateTrader(ev.params.trader)
}
