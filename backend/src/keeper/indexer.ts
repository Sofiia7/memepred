import { CHAIN_PROFILE } from '../chainProfile.js'
import { bytes32ToFeedId } from '../lib/redstone.js'
import { poolTotals } from './poolTotals.js'
import { PoisonTracker, redisPoisonSink } from './poisonTracker.js'
import { AttemptTracker, notParkedSql } from './attemptTracker.js'
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
import { redis } from '../db/redis.js'

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
const E_MATCH_TIED      = parseAbiItem('event MatchTied(uint256 indexed matchId, uint256 price)')
const E_ORDER_REFUNDED  = parseAbiItem('event OrderRefunded(uint256 indexed orderId, address trader, uint256 amount)')
// Emitted once per refunded match, AFTER the OrderRefunded of each side, by both
// emergencyRefundMatch (24h after settleAt) and refundUnpriceableMatch (the
// resolver, right after settleAt). Deployments before commit 091ce58 never emit it.
const E_MATCH_REFUNDED  = parseAbiItem('event MatchRefunded(uint256 indexed matchId)')
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

/**
 * Minimal shape both the real pg.Pool and a test PGlite wrapper satisfy - just
 * enough surface for the transaction processLog runs.
 */
export interface TxClient {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }>
}
export interface TxPool {
  connect(): Promise<TxClient & { release(): void }>
}
/** Anything that can run one statement: a pg.Pool, a client, a test database. */
export type Queryable = Pick<TxClient, 'query'>

/**
 * Claim a log's dedup row and run `body` against the SAME client, inside the
 * SAME transaction, committing both together or neither.
 *
 * Audit A02 (2026-09-28): the dedup row used to be inserted on its own via
 * the pool (markIngested), before any of a handler's business writes ran -
 * each of those writes was then its own separately auto-committed pg.query
 * call. If the RPC or a later statement in the handler failed partway
 * through, the dedup row had already committed by itself: a retry saw the
 * log as already seen and skipped it forever, while some or all of its
 * actual effect on orders/matches had never been written. One transaction
 * for the claim and the handler means a failure anywhere rolls back the
 * claim too, so a retry sees the log as new again and redoes the whole thing.
 *
 * RPC calls (blockTs, a contract read) belong BEFORE this call, not inside
 * `body` - a slow or failing read has no business holding a DB transaction
 * open, and callers below fetch what they need first.
 */
export async function processLog(
  pool: TxPool,
  log: { transactionHash: string | null; logIndex: number | null },
  body: (client: TxClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const claimed = await client.query(
      `INSERT INTO _ingested_logs(tx_hash, log_index) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING tx_hash`,
      [log.transactionHash, log.logIndex],
    )
    if (claimed.rowCount === 0) {
      await client.query('ROLLBACK')
      return
    }
    await body(client)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
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
async function markResolvedMarkets(addresses: string[], db: Queryable = pg) {
  if (addresses.length === 0) return
  await db.query(`
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
async function syncMarketPools(addresses: string[], db: Queryable = pg) {
  if (addresses.length === 0) return
  const lower = [...new Set(addresses.map((a) => a.toLowerCase()))]

  const r = await db.query(`
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
    await db.query(
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
export interface NewMarketRow {
  market: string
  feedId: string
  symbol: string
  duration: number
  /** Unix seconds the market was created at. */
  openedAt: number
  /** Unix seconds; null on rhc, where a market has no close time. */
  closeAt: number | null
  chainId: number
  token: string | null
  /** The factory that announced it, or null when the indexer was not told which. */
  factory: string | null
}

/**
 * Record a market the factory announced, stamped with the factory that did.
 *
 * The stamp is what tells a current market from one an earlier deployment left
 * behind (lib/marketScope.ts). Lower-cased here so that a checksummed address
 * in the environment and the lower-case one every query compares against are
 * the same string. ON CONFLICT DO NOTHING keeps a replay from restamping a row.
 */
export async function insertMarketRow(tx: TxClient, m: NewMarketRow): Promise<void> {
  await tx.query(`
    INSERT INTO markets(market_address, feed_id, feed_symbol, duration_secs, open_time, close_time,
                        status, chain_id, token_address, factory_address)
    VALUES (LOWER($1), $2, $3, $4, to_timestamp($5),
            CASE WHEN $6::bigint IS NULL THEN NULL ELSE to_timestamp($6::bigint) END,
            'OPEN', $7, $8, LOWER($9))
    ON CONFLICT (market_address) DO NOTHING
  `, [m.market, m.feedId, m.symbol, m.duration, m.openedAt, m.closeAt, m.chainId, m.token, m.factory])
}

async function indexFactory(toBlock: bigint) {
  const stream = 'factory'
  const from   = (await getCursor(stream)) + 1n
  if (from > toBlock) return

  // The factory being scanned, stamped on every market it announces. This is
  // what lets the API and the keeper tell a current market from one left behind
  // by an earlier deployment (lib/marketScope.ts, migration 008).
  const factoryAddress = FACTORY ?? null

  for (let start = from; start <= toBlock; start += CHUNK) {
    const end = start + CHUNK - 1n > toBlock ? toBlock : start + CHUNK - 1n
    const logs = await client.getLogs({ address: FACTORY, event: E_MARKET_CREATED, fromBlock: start, toBlock: end })

    for (const log of logs) {
      const { market, feedId, duration, timestamp } = (log as any).args
      const { symbol, token } = await marketIdentity(feedId)
      // close_time is a Base concept. On rhc a market has none - settleAt is
      // set per match - so the column stays null rather than being given an
      // invented far-future value that later code would have to believe.
      const closeTs = CHAIN_PROFILE.rollsOverMarkets ? Number(timestamp) + Number(duration) : null
      await processLog(pg, log, (client) => insertMarketRow(client, {
        market, feedId, symbol,
        duration: Number(duration),
        openedAt: Number(timestamp),
        closeAt: closeTs,
        chainId: CHAIN_PROFILE.chain.id,
        token,
        factory: factoryAddress,
      }))
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
      // DELIBERATELY the first eleven fields only. Audit L01 (2026-09-28) added
      // `expectedPrice` and `slippageBps` to the end of the Order struct, but this
      // indexer still reads markets from EARLIER deployments (they hold real
      // balances and their ledger must stay consistent), and those return only
      // eleven words: decoding them with the thirteen-field ABI throws "Position
      // 383 is out of bounds" and, because reconcilePayouts re-selects the same
      // rows every tick, logs that forever (seen on the VPS on 2026-09-29).
      // Decoding a longer return with this shorter ABI is fine - viem ignores the
      // trailing words - and only positions 5, 9 and 10 are read, so this shape
      // serves every deployment.
    ],
  },
] as const

/** OrderbookMarket.OrderStatus, by ordinal. */
const ORDER_STATUS = ['PENDING', 'MATCHED', 'SETTLED', 'CLAIMED', 'REFUNDED'] as const

/** The fields of an order the projection reads back from the chain rather than deriving. */
export interface OnChainOrder {
  status: number
  payout: bigint
  unmatchedRefunded: boolean
}

/** Reads one order from the chain. Throws when it cannot. */
export type ReadOrder = (market: string, orderId: string) => Promise<OnChainOrder>

const readOrderOnChain: ReadOrder = async (market, orderId) => {
  const o = await client.readContract({
    address: market as Address,
    abi: ORDER_VIEW_ABI,
    functionName: 'getOrder',
    args: [BigInt(orderId)],
  })
  return { status: Number(o[5]), payout: o[9], unmatchedRefunded: o[10] }
}

/**
 * Read each of a settled match's orders' on-chain payout. Split from applying
 * it (below) so the RPC happens before the settled log's own transaction -
 * see processLog's doc comment.
 */
async function fetchSettlementPayouts(
  db: Queryable,
  readOrder: ReadOrder,
  market: string,
  matchId: string,
): Promise<Array<{ orderId: string; payout: bigint }>> {
  const orders = await db.query(
    `SELECT order_id FROM order_matches WHERE market_address = $1 AND match_id = $2`,
    [market, matchId],
  )
  const out: Array<{ orderId: string; payout: bigint }> = []
  for (const { order_id } of orders.rows) {
    try {
      const o = await readOrder(market, String(order_id))
      out.push({ orderId: String(order_id), payout: o.payout })
    } catch (err) {
      // One unreadable order must not stop the batch: the next tick re-reads
      // it, and a wrong payout is worse than a late one.
      console.error(`[indexer] payout read failed for ${market} order ${order_id}:`, err)
    }
  }
  return out
}

/** Write back what fetchSettlementPayouts already read, inside the settled log's own transaction. */
async function applySettlementPayouts(
  tx: TxClient,
  market: string,
  payouts: Array<{ orderId: string; payout: bigint }>,
) {
  for (const { orderId, payout } of payouts) {
    // Zero is a real answer (a losing order owes nothing) but there is
    // nothing to write back for it.
    if (payout === 0n) continue
    await tx.query(
      `UPDATE orders SET payout_usdc = $1::numeric / ${UNIT_DIVISOR}
        WHERE market_address = $2 AND order_id = $3`,
      [payout.toString(), market, orderId],
    )
  }
}

/**
 * MatchTied → settle the match with no winner, and promote its orders.
 * Their own OrderRefunded logs are deliberately skipped by the caller; this
 * is the correct promotion for them instead - the same rule MatchSettled
 * uses (SETTLED once nothing is left pending), but without setting
 * unmatched_refunded, since the whole matched amount came back via the tie
 * rather than an unmatched remainder.
 *
 * Audit A01 (2026-09-28): the promotion below used to run against every
 * PENDING/MATCHED order in the whole market, gated only on having no
 * unsettled match of its own - which a never-matched PENDING order satisfies
 * trivially, having no matches at all. It was promoted to SETTLED by a tie on
 * a completely unrelated pair of orders. Scoping to order_matches rows for
 * THIS match_id fixes that; the unmatched_refunded guard on the PENDING
 * branch additionally keeps a partially-filled order whose remainder is
 * still resting in the book from being closed out while that remainder is
 * still live.
 */
export async function applyMatchTied(
  tx: TxClient,
  market: string,
  matchId: string,
  price: string,
  settledAtUnix: number,
): Promise<void> {
  await tx.query(`
    UPDATE matches SET settled = TRUE, tied = TRUE, exit_price = $1::numeric,
                      settled_at = to_timestamp($2)
    WHERE market_address = $3 AND match_id = $4
  `, [price, settledAtUnix, market, matchId])
  await tx.query(`
    UPDATE orders o SET status = 'SETTLED', settled_at = to_timestamp($1)
    WHERE o.market_address = $2
      AND o.status IN ('MATCHED', 'PENDING')
      AND (o.status = 'MATCHED' OR o.unmatched_refunded)
      AND o.order_id IN (
        SELECT om.order_id FROM order_matches om
        WHERE om.market_address = $2 AND om.match_id = $3
      )
      AND NOT EXISTS (
        SELECT 1 FROM order_matches om
        JOIN matches m ON m.market_address = om.market_address AND m.match_id = om.match_id
        WHERE om.market_address = o.market_address AND om.order_id = o.order_id
          AND m.settled = FALSE
      )
  `, [settledAtUnix, market, matchId])
}

/** The orders that took part in a match, from the projection. */
async function participantsOf(db: Queryable, market: string, matchId: string): Promise<string[]> {
  const r = await db.query(
    `SELECT order_id FROM order_matches WHERE market_address = $1 AND match_id = $2`,
    [market, matchId],
  )
  return r.rows.map((row) => String(row.order_id))
}

/**
 * Identifies "an OrderRefunded log that a match-level event of the SAME
 * transaction already accounts for". By transaction AND order, not by
 * transaction alone: one settlement transaction can carry several matches, and
 * a coarser filter would also swallow an unrelated order's genuine refund
 * riding in the same batch.
 */
function matchLevelRefundKey(txHash: string | null, market: string, orderId: string): string {
  return `${txHash}:${market}:${orderId}`
}

export interface RefundedOrderState {
  orderId: string
  status: (typeof ORDER_STATUS)[number]
  payout: bigint
  unmatchedRefunded: boolean
}

/**
 * Read back every participant of a refunded match from the chain.
 *
 * MatchRefunded says a match was refunded, not what that did to each order:
 * _refundMatch forces both orders to REFUNDED whatever else they hold, may also
 * hand back an unmatched tail in the same transaction, and leaves any winnings
 * from other matches accrued. Re-deriving that here would be a second
 * implementation of the contract's rule, so it is read instead - the same
 * choice reconcilePayouts and reconcileOverdueMatches make. The RPC belongs
 * before the transaction (see processLog's doc comment), and a failed read
 * THROWS: a wrong status on a row that moved money is worse than a late one,
 * and the poison tracker reports it if it keeps failing.
 */
export async function fetchRefundedOrders(
  db: Queryable,
  readOrder: ReadOrder,
  market: string,
  matchId: string,
): Promise<RefundedOrderState[]> {
  const out: RefundedOrderState[] = []
  for (const orderId of await participantsOf(db, market, matchId)) {
    const o = await readOrder(market, orderId)
    out.push({
      orderId,
      status: ORDER_STATUS[o.status] ?? 'PENDING',
      payout: o.payout,
      unmatchedRefunded: o.unmatchedRefunded,
    })
  }
  return out
}

/**
 * MatchRefunded → close the match as refunded and set its participants from
 * what the chain says.
 *
 * emergencyRefundMatch (24h after settleAt) and refundUnpriceableMatch (the
 * resolver, right after settleAt) both end here. `emergency_refunded` is the
 * projection's existing word for "resolved by refunding both stakes" (007), so
 * both paths use it. The matched amount came back, so the generic
 * OrderRefunded handler must NOT also run for these participants in the same
 * transaction - it would set unmatched_refunded on an order that was fully
 * filled - and the caller skips those logs; the chain read carries the truth
 * for an unmatched tail that was handed back at the same time.
 */
export async function applyMatchRefunded(
  tx: TxClient,
  market: string,
  matchId: string,
  settledAtUnix: number,
  orders: RefundedOrderState[],
): Promise<void> {
  await tx.query(`
    UPDATE matches SET settled = TRUE, emergency_refunded = TRUE,
                      settled_at = COALESCE(settled_at, to_timestamp($1))
    WHERE market_address = $2 AND match_id = $3
  `, [settledAtUnix, market, matchId])
  for (const o of orders) {
    await tx.query(`
      UPDATE orders
         SET status = $1,
             payout_usdc = $2::numeric / ${UNIT_DIVISOR},
             unmatched_refunded = $3,
             refunded_at = COALESCE(refunded_at, to_timestamp($4))
       WHERE market_address = $5 AND order_id = $6
    `, [o.status, o.payout.toString(), o.unmatchedRefunded, settledAtUnix, market, o.orderId])
  }
}

/** A log as the handlers below see it: what viem decodes, and what the tests can fake. */
export interface IndexedLog {
  address: string
  blockNumber: bigint | null
  transactionHash: string | null
  logIndex: number | null
  eventName?: string
  args?: any
}

/**
 * Everything one chunk of orderbook logs needs from outside itself, so the
 * handling can run against a test database and a scripted chain.
 */
export interface MarketLogDeps {
  db: TxPool & Queryable
  blockTs: (blockNumber: bigint) => Promise<number>
  readOrder: ReadOrder
  /** Counts consecutive failures of one log; see poisonTracker.ts. Absent in tests that do not care. */
  poison?: PoisonTracker
}

/**
 * Project one chunk of orderbook logs into the tables.
 *
 * Extracted from indexMarketEvents so the ordering rules below can be tested
 * with real SQL and made-up logs; the RPC that fetches the logs stays with the
 * caller.
 *
 * Order matters and is fixed: placed, matched, LP-matched, filled, settled,
 * then the skip set for match-level refunds, then refunded-match, the generic
 * OrderRefunded, tied, claimed. In particular the matched and LP-matched
 * inserts come BEFORE anything that reads `order_matches`: a backfill catching
 * up fast enough puts a match's creation and its tie or refund in the same
 * chunk (RHC's 100,000-block window is about 2.3 hours, well over a 60s market).
 */
export async function processMarketLogs(all: IndexedLog[], deps: MarketLogDeps): Promise<void> {
  const { db, blockTs, readOrder } = deps
  // The log being handled, so a failure can be blamed on it (poisonTracker.ts).
  let current: IndexedLog | null = null
  try {
    // Partition by event name. Order within each bucket is preserved from the
    // caller, which sorts by block then log index - the same ordering the
    // per-event calls produced, so downstream handling is unchanged.
    const byName = (n: string) => all.filter((l) => l.eventName === n)
    const placed        = byName('OrderPlaced')
    const matched       = byName('OrderMatched')
    const lpMatched     = byName('LPMatched')
    const filled        = byName('OrderFilled')
    const settled       = byName('MatchSettled')
    const tied          = byName('MatchTied')
    const refunded      = byName('OrderRefunded')
    const matchRefunded = byName('MatchRefunded')
    const claimed       = byName('Claimed')

    // OrderPlaced → INSERT orders
    for (const log of placed) {
      current = log
      const a = log.args
      const ts = await blockTs(log.blockNumber!)
      await processLog(db, log, async (tx) => {
        await tx.query(`
          INSERT INTO orders(market_address, order_id, trader_address, direction, amount_usdc, placed_at, feed_symbol, placed_tx)
          SELECT LOWER($1), $2, LOWER($3), $4, $5::numeric / ${UNIT_DIVISOR}, to_timestamp($6), m.feed_symbol, $7
          FROM markets m WHERE m.market_address = LOWER($1)
          ON CONFLICT (market_address, order_id) DO NOTHING
        `, [log.address, a.orderId.toString(), a.trader,
            a.dir === 0 ? 'UP' : 'DOWN', a.amount.toString(), ts, log.transactionHash])
      })
    }

    // OrderMatched → INSERT matches + order_matches (×2)
    for (const log of matched) {
      current = log
      const a = log.args
      const ts = await blockTs(log.blockNumber!)
      const mkt = log.address.toLowerCase()
      await processLog(db, log, async (tx) => {
        await tx.query(`
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
          await tx.query(`
            INSERT INTO order_matches(market_address, order_id, match_id, matched_amount)
            VALUES ($1, $2, $3, $4::numeric / ${UNIT_DIVISOR})
            ON CONFLICT DO NOTHING
          `, [mkt, side.toString(), a.matchId.toString(), a.amount.toString()])
        }
        // Bump filled_amount on both orders.
        for (const side of [a.upId, a.downId]) {
          await tx.query(`
            UPDATE orders SET filled_amount = filled_amount + $1::numeric / ${UNIT_DIVISOR},
                              matched_at = COALESCE(matched_at, to_timestamp($2))
            WHERE market_address = $3 AND order_id = $4
          `, [a.amount.toString(), ts, mkt, side.toString()])
        }
      })
    }

    // LPMatched → INSERT matches + order_matches (LP side)
    for (const log of lpMatched) {
      current = log
      const a = log.args
      const ts = await blockTs(log.blockNumber!)
      const mkt = log.address.toLowerCase()
      await processLog(db, log, async (tx) => {
        await tx.query(`
          INSERT INTO matches(market_address, match_id, is_lp_match, user_order_id,
                              amount_usdc, entry_price, matched_at, settle_at)
          SELECT $1, $2, TRUE, $3, $4::numeric / ${UNIT_DIVISOR}, $5::numeric,
                to_timestamp($6), to_timestamp($6) + (m.duration_secs || ' seconds')::INTERVAL
          FROM markets m WHERE m.market_address = $1
          ON CONFLICT (market_address, match_id) DO NOTHING
        `, [mkt, a.matchId.toString(), a.orderId.toString(),
            a.amount.toString(), a.entryPrice.toString(), ts])
        await tx.query(`
          INSERT INTO order_matches(market_address, order_id, match_id, matched_amount)
          VALUES ($1, $2, $3, $4::numeric / ${UNIT_DIVISOR})
          ON CONFLICT DO NOTHING
        `, [mkt, a.orderId.toString(), a.matchId.toString(), a.amount.toString()])
        await tx.query(`
          UPDATE orders SET filled_amount = filled_amount + $1::numeric / ${UNIT_DIVISOR},
                            matched_at = COALESCE(matched_at, to_timestamp($2))
          WHERE market_address = $3 AND order_id = $4
        `, [a.amount.toString(), ts, mkt, a.orderId.toString()])
      })
    }

    // OrderFilled → mark order MATCHED (fully filled)
    for (const log of filled) {
      current = log
      const a = log.args
      const mkt = log.address.toLowerCase()
      await processLog(db, log, async (tx) => {
        await tx.query(`
          UPDATE orders SET status = 'MATCHED'
          WHERE market_address = $1 AND order_id = $2 AND status = 'PENDING'
        `, [mkt, a.orderId.toString()])
      })
    }

    // MatchSettled → mark match settled + close orders that ran out of pending matches
    // (payouts are read back per settled match; see fetchSettlementPayouts)
    for (const log of settled) {
      current = log
      const a = log.args
      const ts = await blockTs(log.blockNumber!)
      const mkt = log.address.toLowerCase()
      // RPC first, outside the transaction below - see processLog's doc comment.
      const payouts = await fetchSettlementPayouts(db, readOrder, mkt, a.matchId.toString())
      await processLog(db, log, async (tx) => {
        await tx.query(`
          UPDATE matches SET settled = TRUE, up_won = $1, exit_price = $2::numeric,
                            settled_at = to_timestamp($3)
          WHERE market_address = $4 AND match_id = $5
        `, [a.upWon, a.exit.toString(), ts, mkt, a.matchId.toString()])
        // Promote orders to SETTLED iff all their matches are settled.
        await tx.query(`
          UPDATE orders o SET status = 'SETTLED', settled_at = to_timestamp($1)
          WHERE o.market_address = $2 AND o.status = 'MATCHED'
            AND NOT EXISTS (
              SELECT 1 FROM order_matches om
              JOIN matches m ON m.market_address = om.market_address AND m.match_id = om.match_id
              WHERE om.market_address = o.market_address AND om.order_id = o.order_id
                AND m.settled = FALSE
            )
        `, [ts, mkt])
        await applySettlementPayouts(tx, mkt, payouts)
      })
    }

    // A tie or a refunded match emits OrderRefunded for its participants in
    // the SAME transaction as the match-level event: OrderbookMarket
    // ._refundTiedMatch runs first and settleMatch emits MatchTied right after;
    // _refundMatch emits one OrderRefunded per side (plus one for an unmatched
    // tail) and MatchRefunded last. The generic OrderRefunded handler below
    // must not also touch those specific orders. For the matched amount it
    // sets unmatched_refunded=TRUE (wrong - nothing was "unmatched", the whole
    // matched amount came back) and only promotes status when
    // filled_amount==0, so a fully-filled order stayed MATCHED forever (a tie
    // emits no MatchSettled to promote it the normal way). The dedicated
    // handlers further below (applyMatchTied, applyMatchRefunded) do it
    // correctly instead. Matched by (transaction, market, orderId) - see
    // matchLevelRefundKey.
    //
    // Computed here, after matched/lpMatched/settled are processed rather
    // than before any of this chunk's own logs are: a backfill catching up
    // fast enough can have a match's OrderMatched/LPMatched AND its
    // MatchTied or MatchRefunded land in the same chunk, and this needs the
    // order_matches rows matched/lpMatched just inserted, not only ones from
    // earlier chunks.
    const matchLevelRefunds = new Set<string>()
    for (const log of [...tied, ...matchRefunded]) {
      current = log
      const mkt = log.address.toLowerCase()
      for (const orderId of await participantsOf(db, mkt, log.args.matchId.toString())) {
        matchLevelRefunds.add(matchLevelRefundKey(log.transactionHash, mkt, orderId))
      }
    }

    // MatchRefunded → the match is closed as refunded, its participants are
    // read back from the chain (RPC first, outside the transaction).
    //
    // Before the generic OrderRefunded loop below, not after it: the chain is
    // read at its head, so the answer already includes whatever a LATER
    // transaction did to the same order (a cancel of a resting remainder), and
    // that later log must be applied on top of it rather than have a read that
    // may be a block behind overwrite it.
    for (const log of matchRefunded) {
      current = log
      const a = log.args
      const ts = await blockTs(log.blockNumber!)
      const mkt = log.address.toLowerCase()
      const orders = await fetchRefundedOrders(db, readOrder, mkt, a.matchId.toString())
      await processLog(db, log, (tx) => applyMatchRefunded(tx, mkt, a.matchId.toString(), ts, orders))
    }

    // OrderRefunded → either full refund (status PENDING → REFUNDED) or
    // partial (unmatched portion). The contract emits the unmatched amount,
    // so we just record unmatched_refunded=true on the order.
    for (const log of refunded) {
      current = log
      const a = log.args
      const mkt = log.address.toLowerCase()
      if (matchLevelRefunds.has(matchLevelRefundKey(log.transactionHash, mkt, a.orderId.toString()))) continue // handled below instead
      const ts = await blockTs(log.blockNumber!)
      await processLog(db, log, async (tx) => {
        await tx.query(`
          UPDATE orders SET
            unmatched_refunded = TRUE,
            refunded_at = COALESCE(refunded_at, to_timestamp($1)),
            status = CASE
              WHEN filled_amount = 0 THEN 'REFUNDED'
              ELSE status
            END
          WHERE market_address = $2 AND order_id = $3
        `, [ts, mkt, a.orderId.toString()])
      })
    }

    // MatchTied → settle the match with no winner, and promote its orders.
    for (const log of tied) {
      current = log
      const a = log.args
      const ts = await blockTs(log.blockNumber!)
      const mkt = log.address.toLowerCase()
      await processLog(db, log, (tx) => applyMatchTied(tx, mkt, a.matchId.toString(), a.price.toString(), ts))
    }

    // Claimed → status CLAIMED, payout recorded, streak/profit update
    for (const log of claimed) {
      current = log
      const a = log.args
      const mkt = log.address.toLowerCase()
      const ts = await blockTs(log.blockNumber!)
      await processLog(db, log, async (tx) => {
        await tx.query(`
          UPDATE orders SET status = 'CLAIMED', claimed_at = to_timestamp($1),
                            payout_usdc = $2::numeric / ${UNIT_DIVISOR}
          WHERE market_address = $3 AND order_id = $4
        `, [ts, a.payout.toString(), mkt, a.orderId.toString()])
      })
    }

    // What follows belongs to the chunk, not to any one log.
    current = { address: '', blockNumber: null, transactionHash: null, logIndex: null, eventName: 'projection-sync' }

    // Only worth re-checking markets that just had a settlement (a tie or a
    // refund, which close a match just as finally) land.
    if (settled.length > 0 || tied.length > 0 || matchRefunded.length > 0) {
      await markResolvedMarkets([...new Set([...settled, ...tied, ...matchRefunded].map((l) => l.address))], db)
    }

    // Any of these events can move committed money, and a refund can move it
    // back, so recompute every market this batch touched.
    await syncMarketPools(all.map((l) => l.address), db)

    await deps.poison?.succeeded()
  } catch (err) {
    if (current) {
      const c: IndexedLog = current
      await deps.poison?.failed({
        txHash: c.transactionHash,
        logIndex: c.logIndex,
        market: c.address ? c.address.toLowerCase() : null,
        event: c.eventName ?? 'unknown',
      }, err)
    }
    throw err
  }
}

/** The dependencies for the real indexer: the real database, the real chain, and Redis for the alarm. */
const MARKET_LOG_DEPS: MarketLogDeps = {
  db: pg,
  blockTs,
  readOrder: readOrderOnChain,
  poison: new PoisonTracker(redisPoisonSink(redis)),
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
          E_MATCH_SETTLED, E_MATCH_TIED, E_ORDER_REFUNDED, E_MATCH_REFUNDED, E_CLAIMED,
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

    await processMarketLogs(all as unknown as IndexedLog[], MARKET_LOG_DEPS)

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
      const a = (log as any).args
      await processLog(pg, log, async (client) => {
        await client.query(`
          INSERT INTO referrals(referrer_address, referee_address)
          VALUES (LOWER($1), LOWER($2))
          ON CONFLICT DO NOTHING
        `, [a.referrer, a.referee])
      })
    }
    await setCursor(stream, end)
  }
}

// ── ENTRY ────────────────────────────────────────────────────
/**
 * Fill in payouts the event stream never carried.
 *
 * fetchSettlementPayouts/applySettlementPayouts run on each MatchSettled,
 * which covers everything from here on. They cannot cover what settled before
 * they existed, and cannot cover a log that was ingested while they were
 * broken - and both leave the same mark: an order the contract owes money to,
 * whose row says it won nothing.
 *
 * That is not a cosmetic gap. market_order_obligations sums payout_usdc to
 * compute the protocol's expected on-chain balance, so every missing payout
 * shows up as invariant drift - and the monitor cannot tell a stale row from
 * real money going missing, which is the one thing it exists to tell.
 *
 * It also fixes the status, and that is the larger half. The event-derived
 * promotion only moves an order out of 'MATCHED', so a PARTIALLY FILLED order -
 * which stays 'PENDING' while it still has an unmatched remainder queued -
 * never left 'PENDING' in the projection even after the contract had settled
 * and closed it. Its accrued payout was then excluded from unclaimed_payout,
 * which counts only MATCHED and SETTLED, and the invariant showed a permanent
 * drift equal to what partially-filled winners were owed. Seen on the soak:
 * order 3 held 0.01 WETH on chain against a row that said PENDING and nothing
 * owed.
 *
 * Read back rather than re-derived. The contract's rule for closing an order
 * involves its unmatched remainder, whether that remainder was refunded, and
 * how many of its matches have settled; a second implementation of that here
 * would be one more thing to drift.
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
      WHERE o.status NOT IN ('CLAIMED', 'REFUNDED')
        AND EXISTS (
          SELECT 1 FROM order_matches om
          JOIN matches m ON m.market_address = om.market_address AND m.match_id = om.match_id
          WHERE om.market_address = o.market_address AND om.order_id = o.order_id
            AND m.settled = TRUE
        )
        AND (o.payout_usdc IS NULL OR o.status = 'PENDING')
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
      const status = ORDER_STATUS[Number(o[5])] ?? 'PENDING'
      // Zero is an answer too - a losing order really is owed nothing - so it
      // is written rather than skipped, or this query returns it forever.
      await pg.query(
        `UPDATE orders
            SET payout_usdc = $1::numeric / ${UNIT_DIVISOR},
                status = $2,
                unmatched_refunded = $3
          WHERE market_address = $4 AND order_id = $5`,
        [o[9].toString(), status, o[10], market_address, order_id],
      )
    } catch (err) {
      console.error(`[indexer] reconcile failed for ${market_address} order ${order_id}:`, err)
    }
  }
  console.log(`[indexer] reconciled ${stale.rowCount} order(s) against the chain`)
}

/** Flat positional layout - see ORDER_VIEW_ABI's comment on why this shape decodes fine. */
const MATCH_VIEW_ABI = [
  {
    name: 'getMatch',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [
      { name: 'upOrderId', type: 'uint256' },
      { name: 'downOrderId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'entryPrice', type: 'uint256' },
      { name: 'settleAt', type: 'uint256' },
      { name: 'exitPrice', type: 'uint256' },
      { name: 'settled', type: 'bool' },
      { name: 'upWon', type: 'bool' },
      { name: 'lpMatch', type: 'bool' },
    ],
  },
] as const

/**
 * Catch a match whose on-chain settled=true was never reflected here.
 *
 * Audit A03 (2026-09-28): emergencyRefundMatch sets match.settled=true on
 * chain but emits only OrderRefunded - this indexer has never had a
 * match-level handler for that at all, so matches.settled stayed FALSE here
 * forever once a match went that way. resolveKeeper.ts's refundOverdueMatches
 * selects its oldest 20 candidates by `settled = FALSE`, so a match stuck in
 * this state occupied one of those 20 slots on every tick even though it can
 * never be refunded again - once 20 such rows exist, no newer overdue match
 * is ever reached.
 *
 * Reading getMatch() back is version-independent: it works whether or not a
 * deployment has a MatchRefunded event, the same reasoning reconcilePayouts
 * already applies to getOrder() rather than trusting the event stream alone.
 * Deployments from commit 091ce58 on DO emit MatchRefunded, and the handler in
 * processMarketLogs applies it as soon as it is indexed - both for the
 * resolver's prompt refund of an unpriceable match and for emergencyRefundMatch
 * - so on those this is only the safety net: an older deployment that never
 * emits it, or a log that was missed. It is not the primary path any more.
 *
 * exitPrice distinguishes an emergency refund from a real settlement: every
 * path through settleMatch (win, loss, or tie) sets it to the resolver's
 * quoted price, which placeBet's own entry check already requires to be
 * nonzero - only emergencyRefundMatch leaves it at zero. This is a reporting
 * flag, not a money movement, so the astronomically unlikely case of a
 * genuine zero quote costs nothing worse than a wrong label here.
 *
 * Scoped to the same window resolveKeeper.ts's overdueMatches() uses
 * (SETTLE_GRACE 24h + its 10-minute clock-skew buffer): that is the earliest
 * moment emergencyRefundMatch is callable at all, so nothing here is ever
 * "stale", only either genuinely unresolved yet (the chain read below is a
 * harmless no-op) or freshly refunded and due to be picked up on this or the
 * next tick - a query that costs nothing when it finds nothing is worth
 * running eagerly rather than adding a second, looser threshold to reason
 * about.
 *
 * The oldest `limit` rows are taken every tick, so a row that stays unsettled
 * on chain (a refund that keeps reverting, a market nobody can move) would be
 * the oldest one on every tick forever and, with enough of them, starve every
 * newer candidate. Each row that shows no progress is counted, and after
 * OVERDUE_MAX_ATTEMPTS in a row it is left out of the selection for
 * OVERDUE_COOLDOWN_MS (attemptTracker.ts), then given one more chance.
 */
const OVERDUE_MAX_ATTEMPTS = Number(process.env.OVERDUE_RECONCILE_MAX_ATTEMPTS ?? '20')
const OVERDUE_COOLDOWN_MS = Number(process.env.OVERDUE_RECONCILE_COOLDOWN_MS ?? String(60 * 60_000))
const overdueAttempts = new AttemptTracker({ maxAttempts: OVERDUE_MAX_ATTEMPTS, cooldownMs: OVERDUE_COOLDOWN_MS })

async function reconcileOverdueMatches(limit = 20) {
  const stale = await pg.query(
    `SELECT market_address, match_id
       FROM matches
      WHERE settled = FALSE
        AND settle_at <= NOW() - INTERVAL '24 hours 10 minutes'
        AND ${notParkedSql('$2')}
      ORDER BY settle_at ASC
      LIMIT $1`,
    [limit, overdueAttempts.parkedKeys()],
  )
  if (stale.rowCount === 0) return

  for (const { market_address, match_id } of stale.rows) {
    const attemptKey = AttemptTracker.keyOf(market_address, match_id)
    try {
      const m = await client.readContract({
        address: market_address as Address,
        abi: MATCH_VIEW_ABI,
        functionName: 'getMatch',
        args: [BigInt(match_id)],
      })
      if (!m[6]) {
        // genuinely still unsettled on chain - not this function's job, but
        // count it so it cannot hold its slot forever.
        if (overdueAttempts.fail(attemptKey)) {
          console.warn(
            `[indexer] overdue match ${market_address}#${match_id} is still unsettled on chain after ` +
            `${OVERDUE_MAX_ATTEMPTS} looks - leaving it out of the sweep for ${Math.round(OVERDUE_COOLDOWN_MS / 60_000)} min`,
          )
        }
        continue
      }

      const exitPrice = m[5]
      const emergencyRefunded = exitPrice === 0n

      await pg.query(
        `UPDATE matches SET settled = TRUE, emergency_refunded = $1,
                            exit_price = $2::numeric, settled_at = COALESCE(settled_at, NOW())
          WHERE market_address = $3 AND match_id = $4`,
        [emergencyRefunded, exitPrice.toString(), market_address, match_id],
      )

      // emergencyRefundMatch forces its orders to REFUNDED regardless of
      // fill state; the generic OrderRefunded handler only does that when
      // filled_amount is 0, so an order that was fully filled before its
      // match got emergency-refunded is stuck at its pre-refund status here.
      // Read each participant back rather than re-deriving the contract's
      // rule - see fetchSettlementPayouts's comment for why.
      const orders = await pg.query(
        `SELECT order_id FROM order_matches WHERE market_address = $1 AND match_id = $2`,
        [market_address, match_id],
      )
      for (const { order_id } of orders.rows) {
        const o = await client.readContract({
          address: market_address as Address,
          abi: ORDER_VIEW_ABI,
          functionName: 'getOrder',
          args: [BigInt(order_id)],
        })
        const status = ORDER_STATUS[Number(o[5])] ?? 'PENDING'
        await pg.query(
          `UPDATE orders SET status = $1, payout_usdc = $2::numeric / ${UNIT_DIVISOR}, unmatched_refunded = $3
            WHERE market_address = $4 AND order_id = $5`,
          [status, o[9].toString(), o[10], market_address, order_id],
        )
      }
      overdueAttempts.clear(attemptKey)
    } catch (err) {
      overdueAttempts.fail(attemptKey)
      console.error(`[indexer] overdue-match reconcile failed for ${market_address} match ${match_id}:`, err)
    }
  }
  console.log(`[indexer] reconciled ${stale.rowCount} overdue match(es) against the chain`)
}

export async function indexerTick() {
  const head = await client.getBlockNumber()
  await indexFactory(head)
  await indexMarketEvents(head)
  await indexReferrals(head)
  await reconcilePayouts()
  await reconcileOverdueMatches()
}
