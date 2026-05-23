import { ReferralRegistered, RefCodeGenerated } from "../../generated/ReferralRegistry/ReferralRegistry"
import { getOrCreateTrader, getStats, ONE_BI } from "./shared"

export function handleReferralRegistered(ev: ReferralRegistered): void {
  let referee = getOrCreateTrader(ev.params.referee)
  referee.referrer = ev.params.referrer
  referee.save()

  let referrer = getOrCreateTrader(ev.params.referrer)
  referrer.referralCount = referrer.referralCount.plus(ONE_BI)
  referrer.save()

  let s = getStats()
  s.totalReferrals = s.totalReferrals.plus(ONE_BI)
  s.lastUpdated    = ev.block.timestamp
  s.save()
}

export function handleRefCodeGenerated(ev: RefCodeGenerated): void {
  let t = getOrCreateTrader(ev.params.referrer)
  t.refCode = ev.params.code
  t.save()
}
