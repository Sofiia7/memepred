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
import { base, baseSepolia } from 'viem/chains'
import { pg } from '../db/pg.js'
import { CONTRACTS, MARKET_FACTORY_ABI, SUPPORTED_FEED_IDS } from '../config.js'
import { getKeeperWalletClient } from './keeperWallet.js'
import { gasGuard } from './gasGuardInstance.js'

const chain = process.env.CHAIN_ID === '8453' ? base : baseSepolia
const publicClient = createPublicClient({ chain, transport: http(process.env.BASE_RPC_URL) })

const DURATIONS_SEC = (process.env.MARKET_DURATIONS_SEC || '300,900,3600,14400,86400')
  .split(',').map((s) => Number(s.trim())).filter((n) => n > 0)

/** Don't create a fresh market if one for the same (feed, dur) closes more
 *  than this far in the future. Default: half the duration. */
const CREATE_LEAD_RATIO = Number(process.env.CREATE_LEAD_RATIO ?? '0.5')

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
  const now  = Date.now()

  for (const feedId of feeds) {
    for (const dur of DURATIONS_SEC) {
      // Lookup an existing OPEN market for (feed, dur) that closes far enough out.
      const leadMs = dur * 1000 * CREATE_LEAD_RATIO
      const fresh = open.find((m) =>
        m.feed_id.toLowerCase() === feedId.toLowerCase() &&
        m.duration_secs === dur &&
        new Date(m.close_time).getTime() - now > leadMs,
      )
      if (fresh) continue

      try {
        const hash = await wallet.writeContract({
          address:      CONTRACTS.MARKET_FACTORY,
          abi:          MARKET_FACTORY_ABI,
          functionName: 'createMarket',
          args:         [feedId, BigInt(dur)],
          // Sprint 5.6: was 5,000,000, sized for the old path where every
          // market was a full OrderbookMarket deployment. Markets are now
          // EIP-1167 clones and this call measures ~330k (see
          // contracts/test/MarketClone.t.sol test_Gas_CreateMarketStaysCheap).
          // Unused gas isn't charged, so this isn't a saving — it's a cap, so
          // a future change that accidentally reintroduces a real deployment
          // fails loudly here instead of quietly costing 10x per market.
          gas:          800_000n,
        })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        await gasGuard.record(receipt.gasUsed, receipt.effectiveGasPrice)
        console.log(`[marketCreator] created market feed=${feedId} dur=${dur}s tx=${hash}`)
      } catch (err) {
        console.error(`[marketCreator] createMarket failed feed=${feedId} dur=${dur}:`, err)
      }
    }
  }
}
