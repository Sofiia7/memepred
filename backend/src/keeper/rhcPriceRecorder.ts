import { createPublicClient, http, type Address } from 'viem'
import { pg } from '../db/pg.js'
import { CHAIN_PROFILE } from '../chainProfile.js'
import { CONTRACTS } from '../config.js'

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
 * creates markets rows but never touches price_history. candles.ts and
 * markets.ts's /stats already key their reads by feed_id, not symbol, which
 * is exactly right for this chain: a launchpad token's symbol is
 * user-chosen and not unique the way its pool address (what feedId encodes
 * here) is, so this writes the same key they already read.
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
 * markets.
 */
export interface RhcPoolPrice {
  feedId: string
  symbol: string
  /** Raw WAD (1e18) value from spotPriceWad. */
  price: bigint
}

/**
 * Read every pool's price, tolerating an individual failure. Exported and
 * given its RPC as a plain injectable function - same shape as
 * invariantMonitor.ts's sumBalances - so this loop's own logic (one bad pool
 * must not stop the rest) is testable without a live chain.
 */
export async function fetchRhcPoolPrices(
  feeds: Array<{ feedId: string; symbol: string }>,
  readPrice: (feedId: string) => Promise<bigint>,
): Promise<RhcPoolPrice[]> {
  const out: RhcPoolPrice[] = []
  for (const { feedId, symbol } of feeds) {
    try {
      out.push({ feedId, symbol, price: await readPrice(feedId) })
    } catch (err) {
      // spotPriceWad reverts on a dead/thin pool or a transient volatility
      // guard - both real, both temporary from this collector's point of
      // view. One bad pool must not stop the rest from being recorded.
      console.error(`[rhcPriceRecorder] price read failed for ${feedId} (${symbol}):`, err)
    }
  }
  return out
}

export async function recordRhcPoolPrices() {
  const { rows } = await pg.query<{ feed_id: string; feed_symbol: string }>(
    `SELECT DISTINCT feed_id, feed_symbol FROM markets`,
  )

  const results = await fetchRhcPoolPrices(
    rows.map((r) => ({ feedId: r.feed_id, symbol: r.feed_symbol })),
    (feedId) =>
      client.readContract({
        address: CONTRACTS.ORACLE_RESOLVER as Address,
        abi: POOL_ORACLE_RESOLVER_ABI,
        functionName: 'spotPriceWad',
        args: [feedId as `0x${string}`],
      }),
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
