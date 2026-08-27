/**
 * indexer — Sprint 3.2
 *
 * Reads OrderbookMarket / MarketFactory / ReferralRegistry events from the
 * RPC and projects them into the orderbook DB schema (orders / matches /
 * order_matches / referrals).
 *
 * Idempotency: every consumed log is fingerprinted in `_ingested_logs`
 * (tx_hash + log_index). A reorg that replays the same log is a no-op.
 *
 * Cursor: per-stream last seen block in `_indexer_cursor`. Loop walks
 * (cursor, head] in CHUNK-sized windows.
 */
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
  type Log,
} from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { pg } from '../db/pg.js'

const chain = process.env.CHAIN_ID === '8453' ? base : baseSepolia
const RPC   = process.env.BASE_RPC_URL
const client = createPublicClient({ chain, transport: http(RPC) })

const FACTORY = process.env.MARKET_FACTORY as Address

// ── EVENTS ────────────────────────────────────────────────────
const E_MARKET_CREATED  = parseAbiItem('event MarketCreated(address indexed market, bytes32 indexed feedId, uint256 duration, uint256 timestamp)')
const E_ORDER_PLACED    = parseAbiItem('event OrderPlaced(uint256 indexed orderId, address indexed trader, uint8 dir, uint256 amount)')
const E_ORDER_MATCHED   = parseAbiItem('event OrderMatched(uint256 indexed matchId, uint256 upId, uint256 downId, uint256 amount, uint256 entryPrice)')
const E_LP_MATCHED      = parseAbiItem('event LPMatched(uint256 indexed matchId, uint256 orderId, uint256 amount, uint256 entryPrice)')
const E_ORDER_FILLED    = parseAbiItem('event OrderFilled(uint256 indexed orderId, uint256 totalFilled)')
const E_MATCH_SETTLED   = parseAbiItem('event MatchSettled(uint256 indexed matchId, bool upWon, uint256 entry, uint256 exit)')
const E_ORDER_REFUNDED  = parseAbiItem('event OrderRefunded(uint256 indexed orderId, address trader, uint256 amount)')
const E_CLAIMED         = parseAbiItem('event Claimed(uint256 indexed orderId, address trader, uint256 payout)')
const E_REFERRAL_REGD   = parseAbiItem('event ReferralRegistered(address indexed referee, address indexed referrer)')

const CHUNK = 1_900n  // Sepolia public RPC caps log queries at ~2000 blocks.

const DEFAULT_START_BLOCK = BigInt(process.env.INDEXER_START_BLOCK || '41926633')

// ── HELPERS ───────────────────────────────────────────────────
async function getCursor(stream: string): Promise<bigint> {
  const r = await pg.query('SELECT last_block FROM _indexer_cursor WHERE stream = $1', [stream])
  if (r.rowCount === 0) return DEFAULT_START_BLOCK
  return BigInt(r.rows[0].last_block)
}

async function setCursor(stream: string, block: bigint) {
  await pg.query(`
    INSERT INTO _indexer_cursor(stream, last_block, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (stream) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = NOW()
  `, [stream, block.toString()])
}

/** True if this log has already been ingested. Atomic insert under lock. */
async function markIngested(tx: string, logIndex: number): Promise<boolean> {
  const r = await pg.query(
    `INSERT INTO _ingested_logs(tx_hash, log_index) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING tx_hash`,
    [tx, logIndex],
  )
  return r.rowCount! > 0 // true if newly inserted (not seen before)
}

/**
 * Markets that can still emit an event we care about.
 *
 * This used to be `status IN ('OPEN','RESOLVED')`, which was wrong twice over.
 * Nothing in the backend has ever written 'RESOLVED' (grep it), so the filter
 * was really just `status = 'OPEN'` — and marketCreator.closeExpiredMarkets()
 * flips a market to 'CLOSED' the moment close_time passes. But a match settles
 * at matchedAt + duration, which is always AFTER close_time, so MatchSettled,
 * Claimed and OrderRefunded all fire once the market has already dropped out of
 * this list. Settlements were therefore never indexed: on 2026-08-09 the one
 * real match in production read settled=true on-chain and settled=f in the DB,
 * and the orderbook cursor had been frozen for 14 days.
 *
 * The window is derived from the contract's own deadlines rather than a round
 * number: the last possible MatchSettled is close_time + duration (the latest
 * settleAt) + SETTLE_GRACE (24h, after which only emergencyRefundMatch works).
 * An hour of slack absorbs clock skew and a late keeper. Orders that are still
 * holding money are included regardless of age, because Claimed has no deadline
 * at all — a user can come back a year later.
 */
async function activeMarkets(): Promise<Address[]> {
  const r = await pg.query(`
    SELECT DISTINCT m.market_address
    FROM markets m
    WHERE m.status = 'OPEN'
       OR m.close_time + (m.duration_secs * INTERVAL '1 second')
                       + INTERVAL '25 hours' > NOW()
       OR EXISTS (
            SELECT 1 FROM orders o
            WHERE o.market_address = m.market_address
              AND o.status NOT IN ('CLAIMED', 'REFUNDED')
          )
  `)
  return r.rows.map((x) => x.market_address as Address)
}

/**
 * A market is RESOLVED once every match it ever had is settled. Nothing wrote
 * this status before, so `markets.status` only ever moved OPEN -> CLOSED and
 * the API's `?status=RESOLVED` filter could never return a row.
 */
async function markResolvedMarkets(addresses: Address[]) {
  if (addresses.length === 0) return
  await pg.query(`
    UPDATE markets m SET status = 'RESOLVED'
    WHERE m.market_address = ANY($1::text[])
      AND m.status = 'CLOSED'
      AND EXISTS     (SELECT 1 FROM matches x WHERE x.market_address = m.market_address)
      AND NOT EXISTS (SELECT 1 FROM matches x WHERE x.market_address = m.market_address
                                               AND x.settled = FALSE)
  `, [addresses.map((a) => a.toLowerCase())])
}

/** getLogs takes an address array, but nodes cap how many they will accept. */
const ADDRESS_BATCH = 250

const tsCache = new Map<bigint, number>()
async function blockTs(bn: bigint): Promise<number> {
  if (tsCache.has(bn)) return tsCache.get(bn)!
  const b = await client.getBlock({ blockNumber: bn })
  const ts = Number(b.timestamp)
  tsCache.set(bn, ts)
  return ts
}

// Sprint 5.5 audit fix: this map only had PEPE/DOGE while the factory has
// had all 13 Tier A feeds whitelisted since the Sprint 5 feed rollout (see
// docs/sprint5/pyth-feeds-base-memes.md) — every other feed's markets were
// silently falling through to 'UNKNOWN', which is exactly the "UNKNOWN / USD"
// market group users see on the Markets page. Verified against the live
// factory's getAllFeedIds() on 2026-07-07 rather than trusting the doc.
function feedSymbolFromId(feedId: string): string {
  const map: Record<string, string> = {
    '0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4': 'PEPE',
    '0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c': 'DOGE',
    '0x9b5729efe3d68e537cdcb2ca70444dea5f06e1660b562632609757076d0b9448': 'BRETT',
    '0x3450d9fbb8c3cf749578315668e21fabb4cd78dcfda1c1cba698b804bae2db2a': 'TOSHI',
    '0x9c93e4a22c56885af427ac4277437e756e7ec403fbc892f975d497383bb33560': 'DEGEN',
    '0x9db37f4d5654aad3e37e2e14ffd8d53265fb3026d1d8f91146539eebaa2ef45f': 'AERO',
    '0x5b2a4c542d4a74dd11784079ef337c0403685e3114ba0d9909b5c7a7e06fdc42': 'MORPHO',
    '0x3cf6bab8bf8041dc8ee2a3edebe16b5f9f4ff3cce46006aeb15c885ba4779d0b': 'WELL',
    '0xa6320c8329924601f4d092dd3f562376f657fa0b5d0cba9e4385a24aaf135384': 'BAN',
    '0xe9f7026d0e26b2643da0cc976bd6107d07092e11f2e4701f98a3c2ef45f0135a': 'B3',
    '0xedbaef2120caa0cc107c332bc2e9ef79b51c80fa4bb746098015c5c366aec42f': 'MOBY',
    '0xc4aa2587b3d35cd526b8e7827f78399d16c7861f719331869c07e5fa499606d0': 'AVNT',
    '0x0fc54579a29ba60a08fdb5c28348f22fd3bec18e221dd6b90369950db638a5a7': 'AIXBT',
  }
  return map[feedId.toLowerCase()] ?? 'UNKNOWN'
}

// ── FACTORY: MarketCreated → markets row ──────────────────────
async function indexFactory(toBlock: bigint) {
  const stream = 'factory'
  const from   = (await getCursor(stream)) + 1n
  if (from > toBlock) return

  for (let start = from; start <= toBlock; start += CHUNK) {
    const end = start + CHUNK - 1n > toBlock ? toBlock : start + CHUNK - 1n
    const logs = await client.getLogs({ address: FACTORY, event: E_MARKET_CREATED, fromBlock: start, toBlock: end })

    for (const log of logs) {
      if (!(await markIngested(log.transactionHash!, log.logIndex!))) continue
      const { market, feedId, duration, timestamp } = (log as any).args
      const closeTs = Number(timestamp) + Number(duration)
      await pg.query(`
        INSERT INTO markets(market_address, feed_id, feed_symbol, duration_secs, open_time, close_time, status)
        VALUES (LOWER($1), $2, $3, $4, to_timestamp($5), to_timestamp($6), 'OPEN')
        ON CONFLICT (market_address) DO NOTHING
      `, [market, feedId, feedSymbolFromId(feedId), Number(duration), Number(timestamp), closeTs])
    }
    await setCursor(stream, end)
  }
}

// ── ORDERBOOK: per-market events → orders/matches/order_matches ──
async function indexMarketEvents(toBlock: bigint) {
  const stream = 'orderbook'
  const from   = (await getCursor(stream)) + 1n
  if (from > toBlock) return

  const markets = await activeMarkets()

  // Read the cursor BEFORE this check and advance it even with nothing to scan.
  // The old code returned early on an empty list, so when market creation
  // stalled (keeper out of gas on 2026-07-26) the cursor froze at that block
  // while the factory and referral streams kept moving. Two weeks later it was
  // 605k blocks behind and would have had to replay all of it. No markets means
  // no market events, so skipping to the head loses nothing.
  if (markets.length === 0) {
    await setCursor(stream, toBlock)
    return
  }

  for (let start = from; start <= toBlock; start += CHUNK) {
    const end = start + CHUNK - 1n > toBlock ? toBlock : start + CHUNK - 1n

    // Sprint 5.6: was seven separate getLogs calls in a Promise.all — same
    // address set, same block range, differing only in topic0. Collapsed into
    // one request with an array of events, which the node answers as a single
    // topic0-OR filter.
    //
    // This is the dominant RPC cost of the whole system: the indexer ticks
    // every 45s, so seven calls was ~17k eth_getLogs/day ≈ 38.9M Alchemy CU a
    // month — just over the 30M free tier, for data that fits in one query.
    // Batched it's ~5.5k/day and the free tier covers it several times over.
    // It also removed the `over rate limit` errors the public node was
    // returning, since seven parallel calls hit the per-second cap directly.
    // Widening activeMarkets() to cover the settlement window means the address
    // list now tracks ~a day of rollovers instead of only the handful that are
    // open, and nodes reject an over-long address filter outright. Slice it.
    const all: Log[] = []
    for (let i = 0; i < markets.length; i += ADDRESS_BATCH) {
      const slice = markets.slice(i, i + ADDRESS_BATCH)
      all.push(...await client.getLogs({
        address: slice,
        events: [
          E_ORDER_PLACED, E_ORDER_MATCHED, E_LP_MATCHED, E_ORDER_FILLED,
          E_MATCH_SETTLED, E_ORDER_REFUNDED, E_CLAIMED,
        ],
        fromBlock: start,
        toBlock:   end,
      }))
    }
    // Batching breaks the node's block/log-index ordering across slices, and the
    // handlers below depend on it (OrderPlaced must land before OrderFilled for
    // the same order). Restore it.
    all.sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? Number(a.logIndex! - b.logIndex!)
        : Number(a.blockNumber! - b.blockNumber!))

    // Partition by event name. Order within each bucket is preserved from the
    // node's response, which is block- then log-index-ordered — the same
    // ordering the per-event calls produced, so downstream handling is
    // unchanged.
    const byName = (n: string) => all.filter((l) => (l as any).eventName === n)
    const placed    = byName('OrderPlaced')
    const matched   = byName('OrderMatched')
    const lpMatched = byName('LPMatched')
    const filled    = byName('OrderFilled')
    const settled   = byName('MatchSettled')
    const refunded  = byName('OrderRefunded')
    const claimed   = byName('Claimed')

    // OrderPlaced → INSERT orders
    for (const log of placed) {
      if (!(await markIngested(log.transactionHash!, log.logIndex!))) continue
      const a = (log as any).args
      const ts = await blockTs(log.blockNumber!)
      await pg.query(`
        INSERT INTO orders(market_address, order_id, trader_address, direction, amount_usdc, placed_at, feed_symbol, placed_tx)
        SELECT LOWER($1), $2, LOWER($3), $4, $5::numeric / 1e6, to_timestamp($6), m.feed_symbol, $7
        FROM markets m WHERE m.market_address = LOWER($1)
        ON CONFLICT (market_address, order_id) DO NOTHING
      `, [log.address, a.orderId.toString(), a.trader,
          a.dir === 0 ? 'UP' : 'DOWN', a.amount.toString(), ts, log.transactionHash])
    }

    // OrderMatched → INSERT matches + order_matches (×2)
    for (const log of matched) {
      if (!(await markIngested(log.transactionHash!, log.logIndex!))) continue
      const a = (log as any).args
      const ts = await blockTs(log.blockNumber!)
      const mkt = log.address.toLowerCase()
      await pg.query(`
        INSERT INTO matches(market_address, match_id, is_lp_match, up_order_id, down_order_id,
                            amount_usdc, entry_price, matched_at, settle_at)
        SELECT $1, $2, FALSE, $3, $4, $5::numeric / 1e6, $6::numeric,
               to_timestamp($7), to_timestamp($7) + (m.duration_secs || ' seconds')::INTERVAL
        FROM markets m WHERE m.market_address = $1
        ON CONFLICT (market_address, match_id) DO NOTHING
      `, [mkt, a.matchId.toString(), a.upId.toString(), a.downId.toString(),
          a.amount.toString(), a.entryPrice.toString(), ts])
      // Link both sides.
      for (const side of [a.upId, a.downId]) {
        await pg.query(`
          INSERT INTO order_matches(market_address, order_id, match_id, matched_amount)
          VALUES ($1, $2, $3, $4::numeric / 1e6)
          ON CONFLICT DO NOTHING
        `, [mkt, side.toString(), a.matchId.toString(), a.amount.toString()])
      }
      // Bump filled_amount on both orders.
      for (const side of [a.upId, a.downId]) {
        await pg.query(`
          UPDATE orders SET filled_amount = filled_amount + $1::numeric / 1e6,
                            matched_at = COALESCE(matched_at, to_timestamp($2))
          WHERE market_address = $3 AND order_id = $4
        `, [a.amount.toString(), ts, mkt, side.toString()])
      }
    }

    // LPMatched → INSERT matches + order_matches (LP side)
    for (const log of lpMatched) {
      if (!(await markIngested(log.transactionHash!, log.logIndex!))) continue
      const a = (log as any).args
      const ts = await blockTs(log.blockNumber!)
      const mkt = log.address.toLowerCase()
      await pg.query(`
        INSERT INTO matches(market_address, match_id, is_lp_match, user_order_id,
                            amount_usdc, entry_price, matched_at, settle_at)
        SELECT $1, $2, TRUE, $3, $4::numeric / 1e6, $5::numeric,
               to_timestamp($6), to_timestamp($6) + (m.duration_secs || ' seconds')::INTERVAL
        FROM markets m WHERE m.market_address = $1
        ON CONFLICT (market_address, match_id) DO NOTHING
      `, [mkt, a.matchId.toString(), a.orderId.toString(),
          a.amount.toString(), a.entryPrice.toString(), ts])
      await pg.query(`
        INSERT INTO order_matches(market_address, order_id, match_id, matched_amount)
        VALUES ($1, $2, $3, $4::numeric / 1e6)
        ON CONFLICT DO NOTHING
      `, [mkt, a.orderId.toString(), a.matchId.toString(), a.amount.toString()])
      await pg.query(`
        UPDATE orders SET filled_amount = filled_amount + $1::numeric / 1e6,
                          matched_at = COALESCE(matched_at, to_timestamp($2))
        WHERE market_address = $3 AND order_id = $4
      `, [a.amount.toString(), ts, mkt, a.orderId.toString()])
    }

    // OrderFilled → mark order MATCHED (fully filled)
    for (const log of filled) {
      if (!(await markIngested(log.transactionHash!, log.logIndex!))) continue
      const a = (log as any).args
      await pg.query(`
        UPDATE orders SET status = 'MATCHED'
        WHERE market_address = $1 AND order_id = $2 AND status = 'PENDING'
      `, [log.address.toLowerCase(), a.orderId.toString()])
    }

    // MatchSettled → mark match settled + close orders that ran out of pending matches
    for (const log of settled) {
      if (!(await markIngested(log.transactionHash!, log.logIndex!))) continue
      const a = (log as any).args
      const ts = await blockTs(log.blockNumber!)
      const mkt = log.address.toLowerCase()
      await pg.query(`
        UPDATE matches SET settled = TRUE, up_won = $1, exit_price = $2::numeric,
                          settled_at = to_timestamp($3)
        WHERE market_address = $4 AND match_id = $5
      `, [a.upWon, a.exit.toString(), ts, mkt, a.matchId.toString()])
      // Promote orders to SETTLED iff all their matches are settled.
      await pg.query(`
        UPDATE orders o SET status = 'SETTLED', settled_at = to_timestamp($1)
        WHERE o.market_address = $2 AND o.status = 'MATCHED'
          AND NOT EXISTS (
            SELECT 1 FROM order_matches om
            JOIN matches m ON m.market_address = om.market_address AND m.match_id = om.match_id
            WHERE om.market_address = o.market_address AND om.order_id = o.order_id
              AND m.settled = FALSE
          )
      `, [ts, mkt])
    }

    // OrderRefunded → either full refund (status PENDING → REFUNDED) or
    // partial (unmatched portion). The contract emits the unmatched amount,
    // so we just record unmatched_refunded=true on the order.
    for (const log of refunded) {
      if (!(await markIngested(log.transactionHash!, log.logIndex!))) continue
      const a = (log as any).args
      const ts = await blockTs(log.blockNumber!)
      await pg.query(`
        UPDATE orders SET
          unmatched_refunded = TRUE,
          refunded_at = COALESCE(refunded_at, to_timestamp($1)),
          status = CASE
            WHEN filled_amount = 0 THEN 'REFUNDED'
            ELSE status
          END
        WHERE market_address = $2 AND order_id = $3
      `, [ts, log.address.toLowerCase(), a.orderId.toString()])
    }

    // Claimed → status CLAIMED, payout recorded, streak/profit update
    for (const log of claimed) {
      if (!(await markIngested(log.transactionHash!, log.logIndex!))) continue
      const a = (log as any).args
      const ts = await blockTs(log.blockNumber!)
      await pg.query(`
        UPDATE orders SET status = 'CLAIMED', claimed_at = to_timestamp($1),
                          payout_usdc = $2::numeric / 1e6
        WHERE market_address = $3 AND order_id = $4
      `, [ts, a.payout.toString(), log.address.toLowerCase(), a.orderId.toString()])
    }

    // Only worth re-checking markets that just had a settlement land.
    if (settled.length > 0) {
      await markResolvedMarkets([...new Set(settled.map((l) => l.address as Address))])
    }

    await setCursor(stream, end)
  }
}

// ── REFERRALS ────────────────────────────────────────────────
async function indexReferrals(toBlock: bigint) {
  const reg = process.env.REFERRAL_REGISTRY as Address
  if (!reg) return
  const stream = 'referrals'
  const from   = (await getCursor(stream)) + 1n
  if (from > toBlock) return

  for (let start = from; start <= toBlock; start += CHUNK) {
    const end  = start + CHUNK - 1n > toBlock ? toBlock : start + CHUNK - 1n
    const logs = await client.getLogs({ address: reg, event: E_REFERRAL_REGD, fromBlock: start, toBlock: end })

    for (const log of logs) {
      if (!(await markIngested(log.transactionHash!, log.logIndex!))) continue
      const a = (log as any).args
      await pg.query(`
        INSERT INTO referrals(referrer_address, referee_address)
        VALUES (LOWER($1), LOWER($2))
        ON CONFLICT DO NOTHING
      `, [a.referrer, a.referee])
    }
    await setCursor(stream, end)
  }
}

// ── ENTRY ────────────────────────────────────────────────────
export async function indexerTick() {
  const head = await client.getBlockNumber()
  await indexFactory(head)
  await indexMarketEvents(head)
  await indexReferrals(head)
}
