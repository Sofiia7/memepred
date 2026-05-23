import { FeeReceived, ReferralCredited } from "../../generated/FeeDistributor/FeeDistributor"
import { FeeFlow, ReferralEarning } from "../../generated/schema"
import { getOrCreateTrader, getStats } from "./shared"

export function handleFeeReceived(ev: FeeReceived): void {
  let id = ev.transaction.hash.toHexString() + "-" + ev.logIndex.toString()
  let f  = new FeeFlow(id)
  f.market   = ev.params.market
  f.totalFee = ev.params.totalFee
  f.referrer = ev.params.referrer
  f.ts       = ev.block.timestamp
  f.tx       = ev.transaction.hash
  f.save()

  let s = getStats()
  s.totalFees   = s.totalFees.plus(ev.params.totalFee)
  s.lastUpdated = ev.block.timestamp
  s.save()
}

export function handleReferralCredited(ev: ReferralCredited): void {
  let id = ev.transaction.hash.toHexString() + "-" + ev.logIndex.toString()
  let r  = new ReferralEarning(id)
  r.referrer = ev.params.referrer
  r.amount   = ev.params.amount
  r.market   = ev.transaction.to as any  // calling market is tx.to
  r.ts       = ev.block.timestamp
  r.tx       = ev.transaction.hash
  r.save()

  let t = getOrCreateTrader(ev.params.referrer)
  t.referralEarnings = t.referralEarnings.plus(ev.params.amount)
  t.save()
}
