/**
 * oracleWatchdog — Sprint 2.5 + 2.6
 *
 * Two responsibilities, one loop:
 *
 *   1. ETH-fund monitor for the OracleResolver
 *      OracleResolver pays Pyth update fees out of its own ETH balance. If it
 *      runs dry, every settle/recordPrice will revert. We track the balance
 *      and warn / page when it drops below thresholds.
 *
 *   2. Stale-oracle auto-pause
 *      For every whitelisted feed, ping Pyth Hermes. If a feed fails N pings
 *      in a row, call MarketFactory.pauseMarketsForFeed(feedId) via the
 *      `emergencyPauser` hot wallet. This freezes all live markets on that
 *      feed until the multisig manually unpauses, which is the right default
 *      when an oracle is misbehaving.
 *
 *      Unpause is intentionally NOT here: it requires multisig signing on
 *      each market.
 */
import {
  createPublicClient,
  http,
  formatEther,
  type Address,
} from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { CONTRACTS, PYTH_HERMES } from '../config.js'
import { redis } from '../db/redis.js'
import { getKeeperWalletClient } from './keeperWallet.js'

const REDIS_KEY = 'watchdog:state'
const REDIS_TTL_SEC = 300 // state expires if keeper dies — surfaces as stale

const chain = process.env.CHAIN_ID === '8453' ? base : baseSepolia
const publicClient = createPublicClient({
  chain,
  transport: http(process.env.BASE_RPC_URL),
})

// ── Thresholds ────────────────────────────────────────────────
/** Warn if OracleResolver ETH is below this. Default: 0.02 ETH. */
const ETH_WARN_WEI    = BigInt(process.env.RESOLVER_ETH_WARN_WEI    ?? '20000000000000000')
/** Page (treat as critical) below this. Default: 0.005 ETH. */
const ETH_CRIT_WEI    = BigInt(process.env.RESOLVER_ETH_CRIT_WEI    ?? '5000000000000000')
/** Consecutive Hermes failures per feed before auto-pausing. */
const STALE_FAIL_LIMIT = Number(process.env.STALE_FAIL_LIMIT ?? '5')
/** Per-feed cool-down after pausing — don't spam pause txs. */
const PAUSE_COOLDOWN_MS = Number(process.env.PAUSE_COOLDOWN_MS ?? String(15 * 60_000))

const MARKET_FACTORY_ABI = [
  {
    name: 'getAllFeedIds',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32[]' }],
  },
  {
    name: 'getActiveMarkets',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'feedId', type: 'bytes32' }],
    outputs: [{ type: 'address[]' }],
  },
  {
    name: 'pauseMarketsForFeed',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'feedId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'emergencyPauser',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const

// ── Per-feed failure / pause state ────────────────────────────
const failStreak  = new Map<string, number>()
const lastPauseAt = new Map<string, number>()

/** Last snapshot — exposed so /api/keeper/health can surface it. */
export const watchdogState = {
  resolverEthWei: 0n,
  resolverEthAlert: 'unknown' as 'ok' | 'warn' | 'critical' | 'unknown',
  feedStatus:      {} as Record<string, { failStreak: number; lastPausedAt?: number }>,
  lastTick:        0,
}

export async function oracleWatchdogTick() {
  watchdogState.lastTick = Date.now()

  await Promise.allSettled([
    checkResolverEthBalance(),
    checkFeedsAndAutoPause(),
  ])

  // Publish snapshot for the backend health endpoint.
  try {
    await redis.setEx(
      REDIS_KEY,
      REDIS_TTL_SEC,
      JSON.stringify({
        resolverEthWei:    watchdogState.resolverEthWei.toString(),
        resolverEthAlert:  watchdogState.resolverEthAlert,
        feedStatus:        watchdogState.feedStatus,
        lastTick:          watchdogState.lastTick,
      }),
    )
  } catch (err) {
    console.error('[watchdog] failed to publish state to redis:', err)
  }
}

// ── 2.5 — Resolver ETH balance ────────────────────────────────
async function checkResolverEthBalance() {
  if (!CONTRACTS.ORACLE_RESOLVER) return
  try {
    const bal = await publicClient.getBalance({
      address: CONTRACTS.ORACLE_RESOLVER as Address,
    })
    watchdogState.resolverEthWei = bal

    if (bal < ETH_CRIT_WEI) {
      watchdogState.resolverEthAlert = 'critical'
      console.error(`[watchdog] CRITICAL: OracleResolver balance = ${formatEther(bal)} ETH — settle will start reverting`)
    } else if (bal < ETH_WARN_WEI) {
      watchdogState.resolverEthAlert = 'warn'
      console.warn(`[watchdog] WARN: OracleResolver balance = ${formatEther(bal)} ETH`)
    } else {
      watchdogState.resolverEthAlert = 'ok'
    }
  } catch (err) {
    console.error('[watchdog] balance check failed:', err)
  }
}

// ── 2.6 — Stale-oracle auto-pause ─────────────────────────────
async function checkFeedsAndAutoPause() {
  if (!CONTRACTS.MARKET_FACTORY) return

  let feeds: readonly `0x${string}`[]
  try {
    feeds = await publicClient.readContract({
      address: CONTRACTS.MARKET_FACTORY as Address,
      abi: MARKET_FACTORY_ABI,
      functionName: 'getAllFeedIds',
    })
  } catch (err) {
    console.error('[watchdog] getAllFeedIds failed:', err)
    return
  }

  for (const feedId of feeds) {
    const ok = await pingHermes(feedId)
    const streak = ok ? 0 : (failStreak.get(feedId) ?? 0) + 1
    failStreak.set(feedId, streak)

    watchdogState.feedStatus[feedId] = {
      failStreak: streak,
      lastPausedAt: lastPauseAt.get(feedId),
    }

    if (!ok && streak >= STALE_FAIL_LIMIT) {
      await maybePauseFeed(feedId, streak)
    }
  }
}

async function pingHermes(feedId: string): Promise<boolean> {
  try {
    const url = `${PYTH_HERMES}/v2/updates/price/latest?ids[]=${feedId}&encoding=hex&parsed=false`
    const r = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    if (!r.ok) return false
    const j = (await r.json()) as { binary?: { data?: unknown[] } }
    return Array.isArray(j.binary?.data) && j.binary!.data!.length > 0
  } catch {
    return false
  }
}

async function maybePauseFeed(feedId: string, streak: number) {
  const last = lastPauseAt.get(feedId) ?? 0
  if (Date.now() - last < PAUSE_COOLDOWN_MS) return

  const wallet = getKeeperWalletClient()
  if (!wallet) {
    console.warn(`[watchdog] feed ${feedId} stale x${streak} but KEEPER_PRIVATE_KEY not set — cannot pause`)
    return
  }

  try {
    const hash = await wallet.writeContract({
      address:      CONTRACTS.MARKET_FACTORY as Address,
      abi:          MARKET_FACTORY_ABI,
      functionName: 'pauseMarketsForFeed',
      args:         [feedId as `0x${string}`],
    })
    await publicClient.waitForTransactionReceipt({ hash })

    lastPauseAt.set(feedId, Date.now())
    console.error(`[watchdog] AUTO-PAUSED feed ${feedId} after ${streak} consecutive Hermes failures (tx ${hash}). Multisig must unpause once Hermes is back.`)
  } catch (err) {
    console.error(`[watchdog] pauseMarketsForFeed failed for ${feedId}:`, err)
  }
}
