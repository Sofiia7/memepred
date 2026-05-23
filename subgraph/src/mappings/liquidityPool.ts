import { BigInt, Bytes } from "@graphprotocol/graph-ts"
import {
  Deposit,
  Withdraw,
  GenesisMinted,
  MatchTaken,
  MatchResult,
  FeeAccrued,
  FeesClaimed
} from "../../generated/LiquidityPool/LiquidityPool"
import { LPVault, LPProvider, LPMatchActivity } from "../../generated/schema"
import { ZERO_BI, ONE_BI } from "./shared"

function getOrCreateVault(addr: Bytes): LPVault {
  let id = addr.toHexString()
  let v  = LPVault.load(id)
  if (v == null) {
    v = new LPVault(id)
    v.totalAssets      = ZERO_BI
    v.totalShares      = ZERO_BI
    v.totalExposure    = ZERO_BI
    v.totalPendingFees = ZERO_BI
    v.genesisCount     = ZERO_BI
    v.providerCount    = ZERO_BI
  }
  return v as LPVault
}

function getOrCreateProvider(addr: Bytes, ts: BigInt): LPProvider {
  let id = addr.toHexString()
  let p  = LPProvider.load(id)
  if (p == null) {
    p = new LPProvider(id)
    p.shares           = ZERO_BI
    p.totalDeposited   = ZERO_BI
    p.totalWithdrawn   = ZERO_BI
    p.pendingFees      = ZERO_BI
    p.totalFeesClaimed = ZERO_BI
    p.isGenesis        = false
    p.joinedAt         = ts
  }
  return p as LPProvider
}

export function handleDeposit(ev: Deposit): void {
  let v = getOrCreateVault(ev.address)
  let p = getOrCreateProvider(ev.params.owner, ev.block.timestamp)
  let isFirst = p.shares.equals(ZERO_BI)

  p.shares          = p.shares.plus(ev.params.shares)
  p.totalDeposited  = p.totalDeposited.plus(ev.params.assets)
  p.save()

  v.totalAssets = v.totalAssets.plus(ev.params.assets)
  v.totalShares = v.totalShares.plus(ev.params.shares)
  if (isFirst) v.providerCount = v.providerCount.plus(ONE_BI)
  v.save()
}

export function handleWithdraw(ev: Withdraw): void {
  let v = getOrCreateVault(ev.address)
  let p = getOrCreateProvider(ev.params.owner, ev.block.timestamp)

  p.shares         = p.shares.gt(ev.params.shares) ? p.shares.minus(ev.params.shares) : ZERO_BI
  p.totalWithdrawn = p.totalWithdrawn.plus(ev.params.assets)
  p.save()

  v.totalAssets = v.totalAssets.gt(ev.params.assets) ? v.totalAssets.minus(ev.params.assets) : ZERO_BI
  v.totalShares = v.totalShares.gt(ev.params.shares) ? v.totalShares.minus(ev.params.shares) : ZERO_BI
  v.save()
}

export function handleGenesisMinted(ev: GenesisMinted): void {
  let v = getOrCreateVault(ev.address)
  v.genesisCount = v.genesisCount.plus(ONE_BI)
  v.save()

  let p = getOrCreateProvider(ev.params.lp, ev.block.timestamp)
  p.isGenesis      = true
  p.genesisTokenId = ev.params.tokenId
  p.save()
}

export function handleMatchTaken(ev: MatchTaken): void {
  let v = getOrCreateVault(ev.address)
  v.totalExposure = v.totalExposure.plus(ev.params.amount)
  v.save()

  let id = ev.params.market.toHexString() + "-" + ev.params.matchId.toString()
  let a  = new LPMatchActivity(id)
  a.market   = ev.params.market
  a.matchId  = ev.params.matchId
  a.amount   = ev.params.amount
  a.orderId  = ev.params.orderId
  a.takenAt  = ev.block.timestamp
  a.save()
}

export function handleMatchResult(ev: MatchResult): void {
  let v = getOrCreateVault(ev.address)
  v.totalExposure = v.totalExposure.gt(ev.params.amount)
                    ? v.totalExposure.minus(ev.params.amount) : ZERO_BI
  v.save()

  let id = ev.params.market.toHexString() + "-" + ev.params.matchId.toString()
  let a  = LPMatchActivity.load(id)
  if (a != null) {
    a.resultLpWon = ev.params.lpWon
    a.resolvedAt  = ev.block.timestamp
    a.save()
  }
}

export function handleFeeAccrued(ev: FeeAccrued): void {
  let v = getOrCreateVault(ev.address)
  v.totalPendingFees = v.totalPendingFees.plus(ev.params.amount)
  v.save()
}

export function handleFeesClaimed(ev: FeesClaimed): void {
  let v = getOrCreateVault(ev.address)
  v.totalPendingFees = v.totalPendingFees.gt(ev.params.amount)
                       ? v.totalPendingFees.minus(ev.params.amount) : ZERO_BI
  v.save()

  let p = getOrCreateProvider(ev.params.lp, ev.block.timestamp)
  p.totalFeesClaimed = p.totalFeesClaimed.plus(ev.params.amount)
  p.pendingFees      = ZERO_BI
  p.save()
}
