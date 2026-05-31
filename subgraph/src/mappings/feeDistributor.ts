import { Bytes } from "@graphprotocol/graph-ts"
import { FeeReceived, ReferralCredited } from "../../generated/FeeDistributor/FeeDistributor"
import { FeeFlow, ReferralEarning } from "../../generated/schema"
import { getOrCreateTrader, getStats } from "./shared"

const ZERO_BYTES = Bytes.fromHexString("0x0000000000000000000000000000000000000000")

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
  // tx.to may be null for contract creation; safe to coerce to zero-bytes.
  let to = ev.transaction.to
  r.market   = to === null ? ZERO_BYTES : Bytes.fromUint8Array(to as Bytes)
  r.ts       = ev.block.timestamp
  r.tx       = ev.transaction.hash
  r.save()

  let t = getOrCreateTrader(ev.params.referrer)
  t.referralEarnings = t.referralEarnings.plus(ev.params.amount)
  t.save()
}
