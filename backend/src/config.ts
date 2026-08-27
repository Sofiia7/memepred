import { config } from 'dotenv'
import { feedIdToBytes32 } from './lib/redstone.js'
config()

import { type Address } from 'viem'

// ── CONTRACT ADDRESSES ─────────────────────────────────────
export const CONTRACTS = {
  USDC:              (process.env.USDC_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') as Address,
  MARKET_FACTORY:    (process.env.MARKET_FACTORY || '0x') as Address,
  ORACLE_RESOLVER:   (process.env.ORACLE_RESOLVER || '0x') as Address,
  FEE_DISTRIBUTOR:   (process.env.FEE_DISTRIBUTOR || '0x') as Address,
  REFERRAL_REGISTRY: (process.env.REFERRAL_REGISTRY || '0x') as Address,
  BADGE_NFT:         (process.env.BADGE_NFT || '0x') as Address,
  LIQUIDITY_POOL:    (process.env.LIQUIDITY_POOL || '0x') as Address,
  GENESIS_NFT:       (process.env.GENESIS_NFT || '0x') as Address,
}

// ── PYTH FEED IDs ──────────────────────────────────────────
/**
 * The feeds this deployment actually supports, and the single source of truth
 * for it. Two separate loops read this: priceRecorder/onchainPriceRecorder
 * (which push Pyth prices) and marketCreator (which now refuses to create a
 * market for anything absent here).
 *
 * 2026-07-25: MarketFactory has had 13 feeds whitelisted since the Sprint 5
 * rollout, but this map only ever had PEPE and DOGE — so 11 feeds were getting
 * markets created on a 5-minute cadence while never receiving an on-chain
 * price at all. Those markets burned gas on every rollover and had no TWAP
 * history for settlement to read an exit price from, so they could not have
 * been settled even if someone had bet on them. Scope is now PEPE and DOGE.
 *
 * Adding a feed here is not sufficient on its own — it must also be
 * whitelisted on the factory (`addFeed`, multisig-only). Removing one here IS
 * sufficient to stop market creation, because marketCreator intersects this
 * map with the factory's list rather than trusting the factory alone.
 */
/**
 * 2026-08-27: these are RedStone symbols right-padded into a bytes32, not Pyth
 * feed hashes. Pyth put every memecoin behind a $500/month plan, so the oracle
 * moved; see lib/redstone.ts. The symbol is also the gateway's own key, so one
 * value serves both the on-chain id and the fetch.
 *
 * BRETT, DEGEN, BONK, WIF, SHIB and FLOKI are all available on RedStone and can
 * be added here - each still needs `addFeed` on the factory (multisig-only).
 * TOSHI and MORPHO are NOT on RedStone; they were on the old Pyth list and
 * would silently produce markets with no price if copied across.
 */
export const FEED_SYMBOLS = ['PEPE', 'DOGE'] as const

export const FEED_IDS: Record<string, string> = Object.fromEntries(
  FEED_SYMBOLS.map((s) => [s, feedIdToBytes32(s)]),
)

/** Lowercased feed ids from FEED_IDS, for O(1) membership checks. */
export const SUPPORTED_FEED_IDS = new Set(
  Object.values(FEED_IDS).map((f) => f.toLowerCase()),
)

// Pyth is gone; RedStone gateway settings live in lib/redstone.ts.
export const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org'
export const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/flipthememe'
export const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
export const PORT = Number(process.env.PORT || 3001)

// ── ABIs (minimal) ─────────────────────────────────────────
export const ORACLE_RESOLVER_ABI = [
  {
    name: 'recordPrice',
    type: 'function',
    stateMutability: 'nonpayable',
    // No price parameter: it rides on the calldata as a RedStone payload, so
    // every call has to be encoded and then extended - see lib/redstone.ts.
    inputs: [
      { name: 'feedId', type: 'bytes32' }
    ],
    outputs: []
  },
  {
    // Replaced legacy `resolveMarket` (didn't exist on-chain after the
    // OrderbookMarket migration). Use the batched variant exclusively.
    name: 'resolveOrderbookMarketBatch',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'market',          type: 'address' },
      { name: 'priceUpdateData', type: 'bytes[]' },
      { name: 'maxCount',        type: 'uint256' }
    ],
    outputs: [{ name: 'settled', type: 'uint256' }]
  }
] as const

export const MARKET_FACTORY_ABI = [
  {
    name: 'createMarket',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'feedId',   type: 'bytes32' },
      { name: 'duration', type: 'uint256' }
    ],
    outputs: [{ name: 'market', type: 'address' }]
  },
  {
    name: 'getActiveMarkets',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'feedId', type: 'bytes32' }],
    outputs: [{ type: 'address[]' }]
  },
  {
    name: 'getAllFeedIds',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32[]' }]
  }
] as const

export const BADGE_NFT_ABI = [
  {
    name: 'mintBadge',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'badgeId', type: 'uint256' }
    ],
    outputs: []
  }
] as const

export const BADGE_NFT_ADDRESS = CONTRACTS.BADGE_NFT
export const ORACLE_RESOLVER_ADDRESS = CONTRACTS.ORACLE_RESOLVER
