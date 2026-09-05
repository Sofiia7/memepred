import { CHAIN_PROFILE } from '../chainProfile.js'
import { bytes32ToFeedId } from '../lib/redstone.js'
import { poolTotals } from './poolTotals.js'
/**
 * indexer - Sprint 3.2
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
import { pg } from '../db/pg.js'

const chain = CHAIN_PROFILE.chain
// The profile's RPC, not BASE_RPC_URL. This one survived the sweep because it
// goes through a local const: on the rhc profile it read undefined and viem
// fell back to the chain's own default, so the indexer worked by accident and
// would have silently read Base the moment BASE_RPC_URL appeared in that
// environment.
const RPC   = CHAIN_PROFILE.rpcUrl
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

/**
 * Raw contract units to the human amounts this schema stores.
 *
 * Was a literal 1e6 in eight places, which is the width of USDC and not of
 * anything else. On the rhc profile stakes are eighteen-decimal WETH, and a
 * partial fill divided by 1e6 would be a million times too large - so this is
 * the profile's currency, written as a SQL numeric literal because the
 * division happens in Postgres rather than in JavaScript, where 1e18 would
 * quietly lose precision on the way through a float.
 */
const UNIT_DIVISOR = `1e${CHAIN_PROFILE.currencyDecimals}`

/**
 * How many blocks one getLogs call may span.
 *
 * 1,900 is Base Sepolia's public cap, and it is not a universal one. Robinhood
 * Chain serves 100,000 - which matters more than it sounds: blocks there are
 * 82ms, so 1,900 of them is under three minutes of chain, and an indexer that
 * has fallen an hour behind would need 23 round trips to catch up on one
 * stream. Measured against the public endpoint, not assumed.
 */
const CHUNK = BigInt(process.env.INDEXER_CHUNK ?? (CHAIN_PROFILE.name === 'rhc' ? 100_000 : 1_900))

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
 * was really just `status = 'OPEN'` - and marketCreator.closeExpiredMarkets()
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
 * at all - a user can come back a year later.
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

/**
 * Project the orders of a market back onto `markets.up_pool` / `down_pool`.
 *
 * Those two columns have existed since 001_init.sql, when markets were to be
 * synced from The Graph, and nothing ever replaced that writer: the only
 * `UPDATE markets` statements in the backend are the two status flips. So they
 * read 0 for every market, always. That is not cosmetic - priceRecorder copies
 * them into `prob_snapshots` each tick and /api/candles/:market/prob-history
 * serves the result, so the odds history chart is a flat 50% line drawn from a
 * table of zeros, even on a market with money on both sides.
 *
 * Recomputed from the orders rather than accumulated per event: a projection
 * that adds and subtracts drifts the moment one log is missed or replayed,
 * while this one is idempotent and self-healing. Markets are passed in
 * explicitly - every address touched by this batch - so a market whose last
 * order was refunded is written back to 0 instead of keeping a stale total.
 */
async function syncMarketPools(addresses: Address[]) {
  if (addresses.length === 0) return
  const lower = [...new Set(addresses.map((a) => a.toLowerCase()))]

  const r = await pg.query(`
    SELECT market_address, direction, amount_usdc, filled_amount, status, unmatched_refunded
    FROM orders WHERE market_address = ANY($1::text[])
  `, [lower])

  const totals = poolTotals(r.rows.map((o: any) => ({
    marketAddress:     o.market_address,
    direction:         o.direction,
    amountUsdc:        Number(o.amount_usdc),
    filledAmount:      Number(o.filled_amount),
    status:            o.status,
    unmatchedRefunded: o.unmatched_refunded,
  })))

  for (const addr of lower) {
    const p = totals.get(addr) ?? { up: 0, down: 0 }
    await pg.query(
      'UPDATE markets SET up_pool = $1, down_pool = $2 WHERE market_address = $3',
      [p.up, p.down, addr],
    )
  }
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

/**
 * The symbol a market's feed id names.
 *
 * This used to be a hardcoded table of Pyth feed hashes, and it fell out of
 * date exactly the way such a table does: the factory gained feeds the map
 * never learned, and their markets showed up on the Markets page as
 * "UNKNOWN / USD".
 *
 * RedStone identifies a feed by its symbol padded into a bytes32, so there is
 * nothing left to look up - the id decodes to the answer, and cannot drift.
 * Ids that are not a plain symbol (the old Pyth hashes are still whitelisted
 * on the factory) decode to '' rather than to mojibake, and still read UNKNOWN.
 */
function feedSymbolFromId(feedId: string): string {
  return bytes32ToFeedId(feedId) || 'UNKNOWN'
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
      const { symbol, token } = await marketIdentity(feedId)
      // close_time is a Base concept. On rhc a market has none - settleAt is
      // set per match - so the column stays null rather than being given an
      // invented far-future value that later code would have to believe.
      const closeTs = CHAIN_PROFILE.rollsOverMarkets ? Number(timestamp) + Number(duration) : null
      await pg.query(`
        INSERT INTO markets(market_address, feed_id, feed_symbol, duration_secs, open_time, close_time,
                            status, chain_id, token_address)
        VALUES (LOWER($1), $2, $3, $4, to_timestamp($5),
                CASE WHEN $6::bigint IS NULL THEN NULL ELSE to_timestamp($6::bigint) END,
                'OPEN', $7, $8)
        ON CONFLICT (market_address) DO NOTHING
      `, [market, feedId, symbol, Number(duration), Number(timestamp), closeTs,
          CHAIN_PROFILE.chain.id, token])
    }
    await setCursor(stream, end)
  }
}

/**
 * What to call a market, and which token it is about.
 *
 * On base a feedId is a symbol right-padded into a bytes32, so decoding it is
 * the whole answer. On rhc it is a pool address and the ticker belongs to the
 * token on the other side of that pool - poolWatcher already read it when the
 * pool was first seen, so this reads it back rather than making another RPC
 * call per market.
 *
 * Falls back to a short form of the pool address. A market on a token whose
 * symbol() reverts is still perfectly tradeable, and refusing to index it over
 * a display string would lose real bets.
 */
async function marketIdentity(feedId: string): Promise<{ symbol: string; token: string | null }> {
  if (CHAIN_PROFILE.name !== 'rhc') return { symbol: feedSymbolFromId(feedId), token: null }

  const pool = `0x${feedId.slice(-40)}`.toLowerCase()
  const r = await pg.query(
    'SELECT token_symbol, token_address FROM pool_candidates WHERE pool_address = $1',
    [pool],
  )
  return {
    symbol: r.rows[0]?.token_symbol || `${pool.slice(0, 8)}…`,
    token: r.rows[0]?.token_address ?? null,
  }
}

/**
 * Write back what a settlement actually paid.
 *
 * MatchSettled carries the winner and the two prices, not the money. The
 * contract accrues the payout onto the winning order at settlement and only
 * emits an amount at Claimed - so between those two moments the row said a
 * settled order had won nothing.
 *
 * That is not cosmetic in two places. The UI reads the row to decide whether
 * there is anything to claim, and market_order_obligations sums payout_usdc
 * over MATCHED and SETTLED orders to compute the protocol's expected on-chain
 * balance - so every unclaimed win understated the expectation and showed up as
 * invariant drift. The monitor was reporting a real-looking warn against a
 * perfectly healthy market.
 *
 * Read from chain rather than derived: the payout depends on feeBps snapshotted
 * at market creation and on whether the LP took the other side
 * (LP_TAKER_FEE_BPS), and a second implementation of that arithmetic here would
 * be a second thing to get wrong.
 *
 * Pre-existing, and invisible until now for a plain reason: nothing had ever
 * been settled. Six orders in the protocol's whole history, none of them
 * carried to payout.
 */
const ORDER_VIEW_ABI = [
  {
    name: 'getOrder',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [
      { name: 'trader', type: 'address' },
      { name: 'direction', type: 'uint8' },
      { name: 'amount', type: 'uint256' },
      { name: 'filledAmount', type: 'uint256' },
      { name: 'referrer', type: 'address' },
      { name: 'status', type: 'uint8' },
      { name: 'placedAt', type: 'uint256' },
      { name: 'matchId', type: 'uint256' },
      { name: 'pendingSettlements', type: 'uint256' },
      { name: 'payout', type: 'uint256' },
      { name: 'unmatchedRefunded', type: 'bool' },
    ],
  },
] as const

async function recordSettlementPayouts(market: string, matchId: string) {
  const orders = await pg.query(
    `SELECT order_id FROM order_matches WHERE market_address = $1 AND match_id = $2`,
    [market, matchId],
  )
  for (const { order_id } of orders.rows) {
    try {
      const o = await client.readContract({
        address: market as `0x${string}`,
        abi: ORDER_VIEW_ABI,
        functionName: 'getOrder',
        args: [BigInt(order_id)],
      })
      const payout = o[9]
      if (payout === 0n) continue
      await pg.query(
        `UPDATE orders SET payout_usdc = $1::numeric / ${UNIT_DIVISOR}
          WHERE market_address = $2 AND order_id = $3`,
        [payout.toString(), market, order_id],
      )
    } catch (err) {
      // One unreadable order must not stop the batch: the next tick re-reads
      // it, and a wrong payout is worse than a late one.
      console.error(`[indexer] payout read failed for ${market} order ${order_id}:`, err)
    }
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

    // Sprint 5.6: was seven separate getLogs calls in a Promise.all - same
    // address set, same block range, differing only in topic0. Collapsed into
    // one request with an array of events, which the node answers as a single
    // topic0-OR filter.
    //
    // This is the dominant RPC cost of the whole system: the indexer ticks
    // every 45s, so seven calls was ~17k eth_getLogs/day ≈ 38.9M Alchemy CU a
    // month - just over the 30M free tier, for data that fits in one query.
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
    // node's response, which is block- then log-index-ordered - the same
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
        SELECT LOWER($1), $2, LOWER($3), $4, $5::numeric / ${UNIT_DIVISOR}, to_timestamp($6), m.feed_symbol, $7
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
        SELECT $1, $2, FALSE, $3, $4, $5::numeric / ${UNIT_DIVISOR}, $6::numeric,
               to_timestamp($7), to_timestamp($7) + (m.duration_secs || ' seconds')::INTERVAL
        FROM markets m WHERE m.market_address = $1
        ON CONFLICT (market_address, match_id) DO NOTHING
      `, [mkt, a.matchId.toString(), a.upId.toString(), a.downId.toString(),
          a.amount.toString(), a.entryPrice.toString(), ts])
      // Link both sides.
      for (const side of [a.upId, a.downId]) {
        await pg.query(`
          INSERT INTO order_matches(market_address, order_id, match_id, matched_amount)
          VALUES ($1, $2, $3, $4::numeric / ${UNIT_DIVISOR})
          ON CONFLICT DO NOTHING
        `, [mkt, side.toString(), a.matchId.toString(), a.amount.toString()])
      }
      // Bump filled_amount on both orders.
      for (const side of [a.upId, a.downId]) {
        await pg.query(`
          UPDATE orders SET filled_amount = filled_amount + $1::numeric / ${UNIT_DIVISOR},
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
        SELECT $1, $2, TRUE, $3, $4::numeric / ${UNIT_DIVISOR}, $5::numeric,
               to_timestamp($6), to_timestamp($6) + (m.duration_secs || ' seconds')::INTERVAL
        FROM markets m WHERE m.market_address = $1
        ON CONFLICT (market_address, match_id) DO NOTHING
      `, [mkt, a.matchId.toString(), a.orderId.toString(),
          a.amount.toString(), a.entryPrice.toString(), ts])
      await pg.query(`
        INSERT INTO order_matches(market_address, order_id, match_id, matched_amount)
        VALUES ($1, $2, $3, $4::numeric / ${UNIT_DIVISOR})
        ON CONFLICT DO NOTHING
      `, [mkt, a.orderId.toString(), a.matchId.toString(), a.amount.toString()])
      await pg.query(`
        UPDATE orders SET filled_amount = filled_amount + $1::numeric / ${UNIT_DIVISOR},
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
    // (payouts are read back per settled match; see recordSettlementPayouts)
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
      await recordSettlementPayouts(mkt, a.matchId.toString())
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
                          payout_usdc = $2::numeric / ${UNIT_DIVISOR}
        WHERE market_address = $3 AND order_id = $4
      `, [ts, a.payout.toString(), log.address.toLowerCase(), a.orderId.toString()])
    }

    // Only worth re-checking markets that just had a settlement land.
    if (settled.length > 0) {
      await markResolvedMarkets([...new Set(settled.map((l) => l.address as Address))])
    }

    // Any of these events can move committed money, and a refund can move it
    // back, so recompute every market this batch touched.
    await syncMarketPools(all.map((l) => l.address as Address))

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
/**
 * Fill in payouts the event stream never carried.
 *
 * recordSettlementPayouts runs on each MatchSettled, which covers everything
 * from here on. It cannot cover what settled before it existed, and it cannot
 * cover a log that was ingested while it was broken - and both leave the same
 * mark: an order the contract owes money to, whose row says it won nothing.
 *
 * That is not a cosmetic gap. market_order_obligations sums payout_usdc to
 * compute the protocol's expected on-chain balance, so every missing payout
 * shows up as invariant drift - and the monitor cannot tell a stale row from
 * real money going missing, which is the one thing it exists to tell.
 *
 * So the reconciliation is here rather than in a one-off repair script: a
 * deployment that adopts the fix heals itself, and so does one that missed a
 * log for any other reason. Bounded per tick, oldest first, because it costs an
 * RPC read per order and nothing about it is urgent.
 */
async function reconcilePayouts(limit = 20) {
  const stale = await pg.query(
    `SELECT o.market_address, o.order_id
       FROM orders o
      WHERE o.payout_usdc IS NULL
        AND o.status IN ('MATCHED', 'SETTLED', 'CLAIMED')
        AND EXISTS (
          SELECT 1 FROM order_matches om
          JOIN matches m ON m.market_address = om.market_address AND m.match_id = om.match_id
          WHERE om.market_address = o.market_address AND om.order_id = o.order_id
            AND m.settled = TRUE
        )
      ORDER BY o.placed_at
      LIMIT $1`,
    [limit],
  )
  if (stale.rowCount === 0) return

  for (const { market_address, order_id } of stale.rows) {
    try {
      const o = await client.readContract({
        address: market_address as Address,
        abi: ORDER_VIEW_ABI,
        functionName: 'getOrder',
        args: [BigInt(order_id)],
      })
      // Zero is an answer too - a losing order really is owed nothing - so it
      // is written rather than skipped, or this query returns it forever.
      await pg.query(
        `UPDATE orders SET payout_usdc = $1::numeric / ${UNIT_DIVISOR}
          WHERE market_address = $2 AND order_id = $3`,
        [o[9].toString(), market_address, order_id],
      )
    } catch (err) {
      console.error(`[indexer] payout reconcile failed for ${market_address} order ${order_id}:`, err)
    }
  }
  console.log(`[indexer] reconciled ${stale.rowCount} payout(s) the event stream had not carried`)
}

export async function indexerTick() {
  const head = await client.getBlockNumber()
  await indexFactory(head)
  await indexMarketEvents(head)
  await indexReferrals(head)
  await reconcilePayouts()
}
