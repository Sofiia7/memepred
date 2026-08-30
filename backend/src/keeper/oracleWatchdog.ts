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
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
import { CONTRACTS, SUPPORTED_FEED_IDS } from '../config.js'
import { fetchPayload, bytes32ToFeedId } from '../lib/redstone.js'
import { nextFailStreak, STALE_FAIL_LIMIT, type FeedPing } from './feedStreak.js'
import { redis } from '../db/redis.js'
import { pg } from '../db/pg.js'
import { getKeeperWalletClient, escalationState } from './keeperWallet.js'
import { gasGuard } from './gasGuardInstance.js'

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

/**
 * The keeper wallet's own thresholds, expressed as runway rather than as a
 * round number of ether.
 *
 * It used to share the resolver's, which were sized for Pyth: the resolver paid
 * an update fee out of its balance and both wallets were assumed to burn at a
 * similar rate. Neither is true now - the resolver spends nothing at all, and
 * the keeper is the only thing paying for anything.
 *
 * Measured on Base Sepolia on 2026-08-27, across market rollovers and on-chain
 * price pushes: 0.000039 ETH/hour, about 0.0009 ETH/day. So:
 *
 *   warn      0.003 ETH  ~ 3 days   - top up soon
 *   critical  0.0005 ETH ~ 13 hours - it will stop working
 *
 * Critical is what makes /api/keeper/health answer 503, and 503 has to mean
 * "this is about to stop", not "there is less than a week left". The shared
 * threshold reported a healthy keeper with three days of runway as down, which
 * is the same way a resolver-balance alarm that cannot cause an outage teaches
 * people to ignore the light that can.
 */
const KEEPER_ETH_WARN_WEI = BigInt(process.env.KEEPER_ETH_WARN_WEI ?? '3000000000000000')
const KEEPER_ETH_CRIT_WEI = BigInt(process.env.KEEPER_ETH_CRIT_WEI ?? '500000000000000')
/** Page (treat as critical) below this. Default: 0.005 ETH. */
const ETH_CRIT_WEI    = BigInt(process.env.RESOLVER_ETH_CRIT_WEI    ?? '5000000000000000')
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
  keeperEthWei:    0n,
  keeperEthAlert:  'unknown' as 'ok' | 'warn' | 'critical' | 'unknown',
  keeperAddress:   '' as string,
  feedStatus:      {} as Record<string, { failStreak: number; lastPausedAt?: number }>,
  // A keeper skipping every routine send because gas is above the ceiling
  // looks exactly like a healthy one from outside the process. Published so it
  // reaches the health probe instead of becoming its own quiet outage.
  gasThrottled:    false,
  gasThrottleReason: null as string | null,
  // A nonce nothing can get past means no settlements, no price pushes and no
  // rollovers, while every process involved looks perfectly alive. Published
  // so it reads as an outage rather than as silence.
  stuckNonce:      null as number | null,
  escalationLevel: 0,
  // Settlements that revert in simulation leave the keeper looking perfectly
  // healthy: gas fine, nonce fine, and the USDC invariant does not drift
  // because nothing settled on-chain. Published so a settlement path that has
  // quietly stopped reads as an outage.
  settlementsOverdueSecs: 0,
  lastTick:        0,
}

/**
 * How far past its deadline the oldest unsettled match is, in seconds.
 *
 * Reads `stale_settlements`, a view that has existed since migration 003 for
 * exactly this purpose and until now had no reader anywhere in the codebase.
 */
async function checkSettlementBacklog() {
  try {
    const { rows } = await pg.query<{ oldest: number | null }>(
      'SELECT MAX(overdue_secs) AS oldest FROM stale_settlements'
    )
    watchdogState.settlementsOverdueSecs = Number(rows[0]?.oldest ?? 0)
  } catch (err) {
    // Leave the previous reading rather than reporting a clean board we did not
    // observe. A database we cannot reach is not evidence that settlement works.
    console.error('[watchdog] settlement backlog query failed:', err)
  }
}

export async function oracleWatchdogTick() {
  watchdogState.lastTick = Date.now()

  const gas = gasGuard.state()
  watchdogState.gasThrottled      = gas.throttled
  watchdogState.gasThrottleReason = gas.reason

  const esc = escalationState()
  watchdogState.stuckNonce      = esc.stuckNonce
  watchdogState.escalationLevel = esc.level

  await Promise.allSettled([
    checkResolverEthBalance(),
    checkKeeperEthBalance(),
    checkFeedsAndAutoPause(),
    checkSettlementBacklog(),
  ])

  // Publish snapshot for the backend health endpoint.
  try {
    await redis.setEx(
      REDIS_KEY,
      REDIS_TTL_SEC,
      JSON.stringify({
        resolverEthWei:    watchdogState.resolverEthWei.toString(),
        resolverEthAlert:  watchdogState.resolverEthAlert,
        keeperEthWei:      watchdogState.keeperEthWei.toString(),
        keeperEthAlert:    watchdogState.keeperEthAlert,
        keeperAddress:     watchdogState.keeperAddress,
        feedStatus:        watchdogState.feedStatus,
        gasThrottled:      watchdogState.gasThrottled,
        gasThrottleReason: watchdogState.gasThrottleReason,
        stuckNonce:        watchdogState.stuckNonce,
        escalationLevel:   watchdogState.escalationLevel,
        settlementsOverdueSecs: watchdogState.settlementsOverdueSecs,
        lastTick:          watchdogState.lastTick,
      }),
    )
  } catch (err) {
    console.error('[watchdog] failed to publish state to redis:', err)
  }
}

// ── 2.5 — Resolver ETH balance ────────────────────────────────
/**
 * The keeper EOA's own balance — the thing that actually pays for every
 * settlement, market rollover and price push.
 *
 * Nothing watched it before. On 2026-07-26 the wallet fell 12 gwei short of its
 * next transaction and every write started throwing; each loop caught the error
 * into console.error, the process stayed up, and this watchdog kept succeeding
 * because it only does eth_calls and Hermes pings. /api/keeper/health therefore
 * reported a healthy keeper for 14 days while it created no markets and settled
 * nothing. Whatever else is broken, an empty wallet must not look like health.
 */
async function checkKeeperEthBalance() {
  const pk = process.env.KEEPER_PRIVATE_KEY
  if (!pk) return
  try {
    const account = privateKeyToAccount(pk as `0x${string}`)
    watchdogState.keeperAddress = account.address
    const bal = await publicClient.getBalance({ address: account.address })
    watchdogState.keeperEthWei = bal

    if (bal < KEEPER_ETH_CRIT_WEI) {
      watchdogState.keeperEthAlert = 'critical'
      console.error(`[watchdog] CRITICAL: keeper wallet ${account.address} = ${formatEther(bal)} ETH — settlements, market creation and price pushes are all failing`)
    } else if (bal < KEEPER_ETH_WARN_WEI) {
      watchdogState.keeperEthAlert = 'warn'
      console.warn(`[watchdog] WARN: keeper wallet ${account.address} = ${formatEther(bal)} ETH`)
    } else {
      watchdogState.keeperEthAlert = 'ok'
    }
  } catch (err) {
    console.error('[watchdog] keeper balance check failed:', err)
  }
}

/**
 * The resolver's balance stopped meaning anything when the oracle moved.
 *
 * It used to pay Pyth's update fee, so an empty resolver stopped settlement -
 * one of the three failures behind the two-week outage. RedStone charges
 * nothing, and the contract no longer even accepts ether. The balance is
 * reported for visibility but must not page: alerting on a number that cannot
 * cause an outage is how real alerts get ignored.
 */
async function checkResolverEthBalance() {
  if (!CONTRACTS.ORACLE_RESOLVER) return
  try {
    const bal = await publicClient.getBalance({
      address: CONTRACTS.ORACLE_RESOLVER as Address,
    })
    watchdogState.resolverEthWei = bal

    // Always 'ok': nothing spends this balance any more. See the note above.
    watchdogState.resolverEthAlert = 'ok'
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

  // Only feeds we carry a price for. The factory's list also holds feeds
  // whitelisted for an oracle we no longer use, whose bytes32 decodes to
  // nonsense - pinging those produced a stack trace per feed per tick and,
  // worse, advanced their fail streak toward auto-pausing markets that were
  // never real. marketCreator intersects the same way.
  const priceable = feeds.filter((f) => SUPPORTED_FEED_IDS.has(f.toLowerCase()))
  if (priceable.length < feeds.length) {
    console.warn(
      `[watchdog] ignoring ${feeds.length - priceable.length} factory feed(s) with no price coverage`,
    )
  }

  for (const feedId of priceable) {
    const ping   = await pingOracle(feedId)
    const streak = nextFailStreak(failStreak.get(feedId) ?? 0, ping)
    failStreak.set(feedId, streak)

    watchdogState.feedStatus[feedId] = {
      failStreak: streak,
      lastPausedAt: lastPauseAt.get(feedId),
    }

    // Only 'unavailable' can reach the limit; see feedStreak.ts for why a
    // credentials failure must not pause anything.
    if (ping === 'unavailable' && streak >= STALE_FAIL_LIMIT) {
      await maybePauseFeed(feedId, streak)
    }
  }
}

/**
 * Can we still build a usable payload for this feed?
 *
 * Deliberately the same call the keeper makes to actually push a price, so a
 * green watchdog means the write path works rather than merely that some
 * endpoint answered.
 */
async function pingOracle(feedId: string): Promise<FeedPing> {
  const symbol = Buffer.from(feedId.slice(2), 'hex').toString('utf8').replace(/\u0000+$/, '')
  try {
    const payload = await fetchPayload(symbol)
    return payload.length > 2 ? 'ok' : 'unavailable'
  } catch (err) {
    // "not enough authorised signers" is about the gateway's data, not our
    // credentials, so it counts toward the feed's streak like any other
    // unavailability. There is no credential to be wrong any more - which is
    // why the 'unauthenticated' arm now only exists for the pause-safety
    // guarantee described in feedStreak.ts.
    console.error(`[watchdog] cannot build a payload for ${symbol}:`, err)
    return 'unavailable'
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
