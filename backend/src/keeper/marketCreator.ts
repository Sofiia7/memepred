import { CHAIN_PROFILE } from '../chainProfile.js'
/**
 * marketCreator — Sprint 3.6
 *
 * Creates a fresh OrderbookMarket for every (feedId × allowed-duration)
 * combination on a cron schedule. Previously this was a manual `cast send`
 * line in scripts/deploy.sh, which doesn't scale beyond demo runs.
 *
 * Strategy:
 *   - Tick every CREATE_INTERVAL_MS (default 5 min).
 *   - For each whitelisted feedId from MarketFactory.getAllFeedIds(),
 *     and each duration in DURATIONS, ensure there's at most one OPEN
 *     market that is still pre-close. If not, create one.
 *   - We treat the DB's `markets` table as source of truth for what's open;
 *     the indexer keeps it synced via MarketCreated events.
 *
 * Idempotency:
 *   - Skips creation when an existing market with the same (feed, duration)
 *     has more than CREATE_LEAD_TIME_SEC remaining before close.
 *   - On-chain createMarket emits MarketCreated which the indexer picks up.
 */
import {
  createPublicClient,
  http,
  type Address,
} from 'viem'
import { pg } from '../db/pg.js'
import { CONTRACTS, MARKET_FACTORY_ABI, SUPPORTED_FEED_IDS } from '../config.js'
import { getKeeperWalletClient, sendKeeperTx } from './keeperWallet.js'
import { gasGuard, recordReceipt } from './gasGuardInstance.js'
import { durationsToMaintain, isUserPresent } from './idleMatrix.js'
import { lastUserActivityMs } from '../lib/activity.js'

const chain = CHAIN_PROFILE.chain
const publicClient = createPublicClient({ chain, transport: http(CHAIN_PROFILE.rpcUrl) })

const DURATIONS_SEC = (process.env.MARKET_DURATIONS_SEC || '300,900,3600,14400,86400')
  .split(',').map((s) => Number(s.trim())).filter((n) => n > 0)

/** Don't create a fresh market if one for the same (feed, dur) closes more
 *  than this far in the future. Default: half the duration. */
const CREATE_LEAD_RATIO = Number(process.env.CREATE_LEAD_RATIO ?? '0.5')

/**
 * While nobody is around, only durations at or above this are kept alive - see
 * idleMatrix.ts for the arithmetic. 3600 drops the 5m and 15m markets, which
 * together are 93% of all market creation and were running around the clock at
 * zero users.
 */
const IDLE_MIN_DURATION_SEC = Number(process.env.IDLE_MIN_DURATION_SEC ?? '3600')
/** Matches PRICE_ACTIVITY_WINDOW_MS in onchainPriceRecorder on purpose: the
 *  two backoffs should agree about whether a human is here. */
const ACTIVITY_WINDOW_MS = Number(process.env.PRICE_ACTIVITY_WINDOW_MS ?? String(15 * 60_000))

/**
 * How often to do the full check while nobody is here. The keeper loop ticks
 * every 30s so the short markets reappear quickly once a visitor arrives, but
 * running the full check that often while idle would put the factory read and
 * the open-markets query on a 10x cadence for no benefit - and the public
 * Base RPC is not free of opinions about that.
 */
const IDLE_CHECK_INTERVAL_MS = Number(process.env.MARKET_IDLE_CHECK_MS ?? String(5 * 60_000))

let lastMatrix = ''
let lastFullCheckAt = 0

interface OpenMarketRow {
  market_address: string
  feed_id: string
  duration_secs: number
  close_time: string // ISO
}

async function openMarkets(): Promise<OpenMarketRow[]> {
  const r = await pg.query<OpenMarketRow>(`
    SELECT market_address, feed_id, duration_secs, close_time::text
    FROM markets
    WHERE status = 'OPEN' AND close_time > NOW()
  `)
  return r.rows
}

/**
 * Sprint 5.5 audit fix: nothing anywhere ever moved a `markets` row off
 * 'OPEN' once its close_time passed — createMissingMarkets() only ever
 * INSERTs new rows, it never retires old ones. Every (feed × duration)
 * slot accumulates a fresh 'OPEN' row roughly every close_time/2, forever,
 * which is exactly the pile of stale "5m ⌁ 00:00" markets users see on the
 * Markets page. This doesn't affect on-chain settlement (that's driven by
 * per-match settleAt via resolveKeeper, independent of this table) — it's
 * purely "stop offering this instance for new bets" bookkeeping for the UI.
 */
async function closeExpiredMarkets() {
  await pg.query(`UPDATE markets SET status = 'CLOSED' WHERE status = 'OPEN' AND close_time <= NOW()`)
}

export async function createMissingMarkets() {
  await closeExpiredMarkets()
  if (!CONTRACTS.MARKET_FACTORY || CONTRACTS.MARKET_FACTORY === '0x') return
  const wallet = getKeeperWalletClient()
  if (!wallet) return

  // Presence is one Redis read and it decides both how often to look and what
  // to maintain, so it comes before anything that touches the chain.
  const now      = Date.now()
  const activity = await lastUserActivityMs()
  const present  = isUserPresent(activity, now, ACTIVITY_WINDOW_MS)
  if (!present && now - lastFullCheckAt < IDLE_CHECK_INTERVAL_MS) return
  lastFullCheckAt = now

  let feeds: readonly `0x${string}`[]
  try {
    feeds = await publicClient.readContract({
      address: CONTRACTS.MARKET_FACTORY,
      abi: MARKET_FACTORY_ABI,
      functionName: 'getAllFeedIds',
    })
  } catch (err) {
    console.error('[marketCreator] getAllFeedIds failed:', err)
    return
  }

  if (feeds.length === 0) return

  // Only create markets for feeds this deployment can actually price. The
  // factory's whitelist is multisig-controlled and currently carries 13 feeds
  // from the Sprint 5 rollout, but the keeper only pushes Pyth prices for the
  // ones in FEED_IDS. A market on an unpriced feed is worse than no market:
  // it costs gas every rollover forever, and settlement has no TWAP history to
  // read an exit price from.
  //
  // Logged rather than silently dropped — a keeper quietly ignoring most of
  // the factory's configuration is exactly the kind of thing that should be
  // visible in the logs, not discovered from a gas bill.
  const supported = feeds.filter((f) => SUPPORTED_FEED_IDS.has(f.toLowerCase()))
  const skipped   = feeds.length - supported.length
  if (skipped > 0) {
    console.warn(
      `[marketCreator] skipping ${skipped} factory feed(s) with no price coverage ` +
      `(creating for ${supported.length}/${feeds.length}). To retire them on-chain, ` +
      `the multisig must call MarketFactory.removeFeed for each.`,
    )
  }
  if (supported.length === 0) return
  feeds = supported

  // Rolling a market forward early is routine: the existing market stays open
  // and tradeable, so a skipped tick costs lead time, not availability.
  if (await gasGuard.check('routine')) return

  const open = await openMarkets()

  // Don't pay to roll 5-minute markets at 4am for nobody. The long durations
  // stay up so the board is never empty; the short ones come back within one
  // tick of the first request that stamps the activity key.
  const durations = durationsToMaintain(
    DURATIONS_SEC,
    activity,
    now,
    { idleMinDurationSec: IDLE_MIN_DURATION_SEC, activityWindowMs: ACTIVITY_WINDOW_MS },
  )
  const matrix = durations.join(',')
  if (matrix !== lastMatrix) {
    console.log(
      durations.length === DURATIONS_SEC.length
        ? `[marketCreator] user present - maintaining all durations (${matrix})`
        : `[marketCreator] idle - maintaining ${matrix}, dropping ${
            DURATIONS_SEC.filter(d => !durations.includes(d)).join(',')}`,
    )
    lastMatrix = matrix
  }

  for (const feedId of feeds) {
    for (const dur of durations) {
      // Lookup an existing OPEN market for (feed, dur) that closes far enough out.
      const leadMs = dur * 1000 * CREATE_LEAD_RATIO
      const fresh = open.find((m) =>
        m.feed_id.toLowerCase() === feedId.toLowerCase() &&
        m.duration_secs === dur &&
        new Date(m.close_time).getTime() - now > leadMs,
      )
      if (fresh) continue

      try {
        const hash = await sendKeeperTx(fees => wallet.writeContract({
          address:      CONTRACTS.MARKET_FACTORY,
          abi:          MARKET_FACTORY_ABI,
          functionName: 'createMarket',
          args:         [feedId, BigInt(dur)],
          ...fees,
          // Sprint 5.6: was 5,000,000, sized for the old path where every
          // market was a full OrderbookMarket deployment. Markets are now
          // EIP-1167 clones and this call measures ~330k (see
          // contracts/test/MarketClone.t.sol test_Gas_CreateMarketStaysCheap).
          // Unused gas isn't charged, so this isn't a saving — it's a cap, so
          // a future change that accidentally reintroduces a real deployment
          // fails loudly here instead of quietly costing 10x per market.
          gas:          800_000n,
        }), 'createMarket')
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        await recordReceipt(receipt, 'routine')
        console.log(`[marketCreator] created market feed=${feedId} dur=${dur}s tx=${hash}`)
      } catch (err) {
        console.error(`[marketCreator] createMarket failed feed=${feedId} dur=${dur}:`, err)
      }
    }
  }
}
