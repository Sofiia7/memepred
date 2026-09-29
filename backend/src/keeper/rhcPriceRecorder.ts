import { createPublicClient, http, type Address } from 'viem'
import { pg } from '../db/pg.js'
import { CHAIN_PROFILE } from '../chainProfile.js'
import { CONTRACTS } from '../config.js'
import { andFactory, currentFactory } from '../lib/marketScope.js'
import { oneLine } from '../lib/errorText.js'

const client = createPublicClient({ chain: CHAIN_PROFILE.chain, transport: http(CHAIN_PROFILE.rpcUrl) })

const POOL_ORACLE_RESOLVER_ABI = [
  {
    name: 'spotPriceWad',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

/**
 * Off-chain price history for RHC pool markets.
 *
 * priceRecorder.ts's recordAllPrices never runs here - CHAIN_PROFILE
 * .pushesPricesOnChain is false for rhc, and that function is symbol-keyed
 * against a static Base feed map that has no meaning for a permissionless
 * pool anyway. This is the neighbour, not an adaptation of it in place, the
 * same relationship PoolOracleResolver has to OracleResolver.
 *
 * Audit A07 (2026-09-28): with nothing recording, a fresh RHC deployment's
 * candles and 24h stats had no data at all to read, ever - factory indexing
 * creates markets rows but never touches price_history. candles.ts reads
 * price_history by feed_id, which is exactly right for this chain: a launchpad
 * token's symbol is user-chosen and not unique the way its pool address (what
 * feedId encodes here) is, so this writes the same key it reads. /api/markets
 * /stats used to group by symbol instead, and two pools sharing a ticker had
 * their prices merged into one row; on rhc it now groups by feed_id too (audit
 * follow-up 2026-09-28).
 *
 * Records the resolver's own entry TWAP (spotPriceWad, a 60s window) rather
 * than raw instantaneous spot: that is the same price a bet actually strikes
 * at, there is no public view for pure spot on this resolver, and
 * reimplementing Uniswap's tick math off-chain to get one would be a second
 * implementation of arithmetic the contract already does - see
 * fetchSettlementPayouts in indexer.ts for the same reasoning applied to
 * payouts. It is also an honest label for what a candle built from this
 * series actually shows: the price a trade could have struck at that moment,
 * not a raw, freely-manipulable tick.
 *
 * One market per pool would poll the same pool repeatedly for no reason -
 * price is a property of the pool, not of any one market's duration - so
 * this iterates distinct feed_id (which is the pool, one-to-one) rather than
 * markets. Only feeds of the CURRENT factory's markets: an earlier
 * deployment's markets are dead, and polling their pools every 30 seconds
 * bought nothing and logged an error per failing pool.
 */
export interface RhcPoolPrice {
  feedId: string
  symbol: string
  /** Raw WAD (1e18) value from spotPriceWad. */
  price: bigint
}

/** The recorder ticks every 30s, so 20 ticks is the ten minutes the backoff is capped at. */
export const MAX_BACKOFF_TICKS = 20

/**
 * Per-feed exponential backoff for reads that keep failing.
 *
 * A pool that reverts (`pool has no liquidity`, a volatility guard) reverts
 * again 30 seconds later, and the read plus its log line were being repeated
 * for it every tick, forever. After the n-th consecutive failure the next
 * 2^n ticks skip the read (capped), and one success forgets it all.
 *
 * Skipping writes nothing, and so does a failure: a pool that cannot be read
 * never gets a zero price recorded for it - a gap in a candle is honest, a
 * zero would be a fabricated crash.
 */
export class FeedBackoff {
  private readonly state = new Map<string, { failures: number; skip: number }>()

  constructor(private readonly maxSkipTicks = MAX_BACKOFF_TICKS) {}

  /** Whether to skip this feed on this tick. Consumes one tick of its wait. */
  shouldSkip(feedId: string): boolean {
    const s = this.state.get(feedId)
    if (!s || s.skip <= 0) return false
    s.skip -= 1
    return true
  }

  /** A read failed. Returns the streak and how many ticks will now be skipped. */
  failed(feedId: string): { failures: number; skipTicks: number } {
    const failures = (this.state.get(feedId)?.failures ?? 0) + 1
    const skipTicks = Math.min(2 ** failures, this.maxSkipTicks)
    this.state.set(feedId, { failures, skip: skipTicks })
    return { failures, skipTicks }
  }

  /** A read worked. Returns the failure streak it ended, 0 if there was none. */
  succeeded(feedId: string): number {
    const failures = this.state.get(feedId)?.failures ?? 0
    this.state.delete(feedId)
    return failures
  }
}

/**
 * Read every pool's price, tolerating an individual failure. Exported and
 * given its RPC as a plain injectable function - same shape as
 * invariantMonitor.ts's sumBalances - so this loop's own logic (one bad pool
 * must not stop the rest) is testable without a live chain.
 *
 * `backoff` is optional so the function keeps its plain meaning for callers
 * that want every pool read every time.
 */
export async function fetchRhcPoolPrices(
  feeds: Array<{ feedId: string; symbol: string }>,
  readPrice: (feedId: string) => Promise<bigint>,
  backoff?: FeedBackoff,
): Promise<RhcPoolPrice[]> {
  const out: RhcPoolPrice[] = []
  for (const { feedId, symbol } of feeds) {
    if (backoff?.shouldSkip(feedId)) continue
    try {
      const price = await readPrice(feedId)
      const ended = backoff?.succeeded(feedId) ?? 0
      if (ended > 0) console.log(`[rhcPriceRecorder] ${feedId} (${symbol}) reads again after ${ended} failed attempt(s)`)
      out.push({ feedId, symbol, price })
    } catch (err) {
      // spotPriceWad reverts on a dead/thin pool or a transient volatility
      // guard - both real, both temporary from this collector's point of
      // view. One bad pool must not stop the rest from being recorded.
      //
      // ONE line, short message only. The viem error object carries the whole
      // call, the ABI and the RPC url - about sixty lines a pool per tick.
      const b = backoff?.failed(feedId)
      console.error(
        `[rhcPriceRecorder] price read failed for ${feedId} (${symbol}): ${oneLine(err)}` +
        (b ? ` [failure ${b.failures}, next try in ${b.skipTicks + 1} ticks]` : ''),
      )
    }
  }
  return out
}

/**
 * The feeds worth reading: those of the current factory's markets, one row per
 * pool, named after its newest market. Exported for the test.
 */
export function currentFeedsQuery(factory: string | null = currentFactory()): string {
  return `SELECT DISTINCT ON (m.feed_id) m.feed_id, m.feed_symbol
            FROM markets m
           WHERE TRUE${andFactory('m.factory_address', factory)}
           ORDER BY m.feed_id, m.open_time DESC`
}

const backoff = new FeedBackoff()

export async function recordRhcPoolPrices() {
  const { rows } = await pg.query<{ feed_id: string; feed_symbol: string }>(currentFeedsQuery())

  const results = await fetchRhcPoolPrices(
    rows.map((r) => ({ feedId: r.feed_id, symbol: r.feed_symbol })),
    (feedId) =>
      client.readContract({
        address: CONTRACTS.ORACLE_RESOLVER as Address,
        abi: POOL_ORACLE_RESOLVER_ABI,
        functionName: 'spotPriceWad',
        args: [feedId as `0x${string}`],
      }),
    backoff,
  )

  for (const { feedId, symbol, price } of results) {
    // Divided in SQL, not JS - see indexer.ts's UNIT_DIVISOR comment: a WAD
    // value can run past Number's safe integer precision for an extreme
    // price ratio, and this is exactly the kind of thing that would
    // silently drift rather than throw.
    await pg.query(
      `INSERT INTO price_history (feed_id, symbol, price, recorded_at) VALUES ($1, $2, $3::numeric / 1e18, NOW())`,
      [feedId, symbol, price.toString()],
    )
  }
}
