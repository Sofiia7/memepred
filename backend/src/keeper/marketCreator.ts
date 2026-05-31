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
  createWalletClient,
  http,
  type Address,
} from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { pg } from '../db/pg.js'
import { CONTRACTS, MARKET_FACTORY_ABI } from '../config.js'

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

export async function createMissingMarkets() {
  if (!CONTRACTS.MARKET_FACTORY || CONTRACTS.MARKET_FACTORY === '0x') return
  const key = process.env.KEEPER_PRIVATE_KEY as `0x${string}` | undefined
  if (!key) return

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

  const open = await openMarkets()
  const now  = Date.now()
  const account = privateKeyToAccount(key)
  const wallet = createWalletClient({ account, chain, transport: http(process.env.BASE_RPC_URL) })

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
          gas:          5_000_000n,
        })
        await publicClient.waitForTransactionReceipt({ hash })
        console.log(`[marketCreator] created market feed=${feedId} dur=${dur}s tx=${hash}`)
      } catch (err) {
        console.error(`[marketCreator] createMarket failed feed=${feedId} dur=${dur}:`, err)
      }
    }
  }
}
