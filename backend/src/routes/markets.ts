import { FastifyInstance } from 'fastify'
import { z }     from 'zod'
import { pg }    from '../db/pg.js'
import { redis } from '../db/redis.js'
import { CHAIN_PROFILE } from '../chainProfile.js'
import { andFactory, andMarketInFactory } from '../lib/marketScope.js'
import { zAddress, zFeedId, zStatus, parse } from '../lib/validate.js'

const ListQuery = z.object({
  status: zStatus.optional(),
  feedId: zFeedId.optional()
})

const ByAddressParams = z.object({ address: zAddress })

const OrderMatchesParams = z.object({
  address: zAddress,
  orderId: z.string().regex(/^\d+$/, 'invalid order id'),
})

export async function marketsRoutes(app: FastifyInstance) {

  app.get('/', async (req, reply) => {
    const q = parse(ListQuery, req.query, reply); if (!q) return

    const cacheKey = `markets:${q.status || 'all'}:${q.feedId || 'all'}`
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    // On rhc, only markets of the factory this deployment is on. Earlier
    // deployments leave their markets in the table (their balances still count
    // for the ledger), but they are not something to show or to bet on: the
    // frontend labels them "NOT A REAL MARKET". See lib/marketScope.ts.
    let query = `SELECT * FROM markets WHERE 1=1${andFactory('factory_address')}`
    const params: any[] = []

    if (q.status) { params.push(q.status); query += ` AND status = $${params.length}` }
    if (q.feedId) { params.push(q.feedId); query += ` AND feed_id = $${params.length}` }

    query += ' ORDER BY open_time DESC LIMIT 50'

    const result = await pg.query(query, params)
    const markets = result.rows.map(r => ({
      address:     r.market_address,
      feedId:      r.feed_id,
      feedSymbol:  r.feed_symbol,
      duration:    r.duration_secs,
      openTime:    Math.floor(new Date(r.open_time).getTime() / 1000),
      // Null on rhc, where a market has no close time at all - and
      // `new Date(null)` is the epoch, so the old expression served 0
      // rather than "none", which a client cannot tell from 1970.
      closeTime:   r.close_time === null ? null : Math.floor(new Date(r.close_time).getTime() / 1000),
      entryPrice:  r.entry_price ? parseFloat(r.entry_price) : null,
      exitPrice:   r.exit_price  ? parseFloat(r.exit_price)  : null,
      status:      r.status,
      upWon:       r.up_won,
      upPool:      parseFloat(r.up_pool),
      downPool:    parseFloat(r.down_pool),
    }))

    await redis.setEx(cacheKey, 15, JSON.stringify(markets))
    return markets
  })

  app.get('/:address', async (req, reply) => {
    const p = parse(ByAddressParams, req.params, reply); if (!p) return

    const cacheKey = `market:${p.address}`
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    // A market of an earlier factory is 404 on rhc, exactly as if it did not
    // exist: see the list route above.
    const result = await pg.query(
      `SELECT * FROM markets WHERE market_address = $1${andFactory('factory_address')}`,
      [p.address],
    )
    if (!result.rows[0]) return reply.code(404).send({ error: 'market not found' })

    const r = result.rows[0]
    const market = {
      address:    r.market_address,
      feedId:     r.feed_id,
      feedSymbol: r.feed_symbol,
      duration:   r.duration_secs,
      openTime:   Math.floor(new Date(r.open_time).getTime() / 1000),
      closeTime:  r.close_time === null ? null : Math.floor(new Date(r.close_time).getTime() / 1000),
      entryPrice: r.entry_price ? parseFloat(r.entry_price) : null,
      exitPrice:  r.exit_price  ? parseFloat(r.exit_price)  : null,
      status:     r.status,
      upWon:      r.up_won,
      upPool:     parseFloat(r.up_pool),
      downPool:   parseFloat(r.down_pool),
    }

    // Sprint 3.3: orders instead of bets. "won" is derived from payout.
    const bets = await pg.query(
      `SELECT trader_address, direction, amount_usdc, filled_amount,
              COALESCE(payout_usdc, 0) > 0 AS won, payout_usdc, placed_at, status
       FROM orders WHERE market_address = $1 ORDER BY placed_at DESC`,
      [p.address]
    )

    const out = { ...market, bets: bets.rows }
    await redis.setEx(cacheKey, 10, JSON.stringify(out))
    return out
  })

  // 24h aggregate stats: total bet volume + latest price & 24h change % per feed
  app.get('/stats', async () => {
    const cacheKey = 'markets:stats:24h'
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    // Total volume (sum of filled USDC at risk in last 24h). On rhc only the
    // current factory's markets count: an earlier deployment's orders are not
    // part of what this product is doing today.
    const volRes = await pg.query<{ vol: string }>(
      `SELECT COALESCE(SUM(filled_amount), 0)::text AS vol
         FROM orders
        WHERE placed_at >= NOW() - INTERVAL '24 hours'${andMarketInFactory('market_address')}`,
    )
    const volume24h = parseFloat(volRes.rows[0]?.vol ?? '0')

    // Latest price + price closest to 24h ago, one row per feed.
    //
    // On rhc the key is the FEED (the pool), not the symbol: a symbol there is
    // whatever the token's deployer chose, two pools can carry the same one,
    // and grouping by it merged their prices into whichever row happened to be
    // newest. A pool address cannot collide. On Base a symbol IS the feed, and
    // price_history there still holds rows written under an older oracle's ids
    // for the same symbols, so grouping by feed_id would list a symbol twice -
    // it stays keyed by symbol, exactly as it was. `feedId` is returned either
    // way; `symbol` stays for the clients that look prices up by it.
    // (The key is one of two fixed identifiers, never input.)
    const key = CHAIN_PROFILE.name === 'rhc' ? 'feed_id' : 'symbol'
    const sym = await pg.query<{
      feed_id: string; symbol: string; latest: string; prior: string | null
    }>(
      `WITH latest AS (
         SELECT DISTINCT ON (${key}) feed_id, symbol, price, recorded_at
           FROM price_history
          ORDER BY ${key}, recorded_at DESC
       ),
       prior AS (
         SELECT DISTINCT ON (${key}) feed_id, symbol, price
           FROM price_history
          WHERE recorded_at <= NOW() - INTERVAL '24 hours'
          ORDER BY ${key}, recorded_at DESC
       )
       SELECT l.feed_id,
              l.symbol,
              l.price::text  AS latest,
              p.price::text  AS prior
         FROM latest l
         LEFT JOIN prior p ON p.${key} = l.${key}`
    )

    const symbols = sym.rows.map(r => {
      const latest = parseFloat(r.latest)
      const prior = r.prior !== null ? parseFloat(r.prior) : null
      const chg24h = prior && prior > 0 ? ((latest - prior) / prior) * 100 : 0
      return { feedId: r.feed_id, symbol: r.symbol, price: latest, chg24h }
    })

    const out = { volume24h, symbols }
    await redis.setEx(cacheKey, 30, JSON.stringify(out))
    return out
  })

  /**
   * Every match an order has ever been part of, with a per-match outcome.
   *
   * Audit A04 (2026-09-28): the UI reduced an order to its FIRST match only
   * (Order.matchId, kept on-chain "for back-compat / view ease" - see
   * OrderbookMarket.sol's own comment on it), so a multi-fill order's later
   * matches were invisible: a tied first match hid a won second one, Recover
   * targeted the wrong matchId once the first settled but a second stalled,
   * and an order force-REFUNDED by one emergency refund still had a real
   * claimable payout from a different, already-won match that no REFUNDED
   * branch in the UI ever offered. This is what a frontend needs to render
   * the honest aggregate instead of guessing from a single enum - claim
   * eligibility itself is still read live from getOrder() (pendingSettlements
   * / payout / status), which already aggregates correctly on-chain; this
   * endpoint exists for display and for finding the RIGHT stuck match, not
   * for re-deriving money math the contract already gets right.
   */
  app.get('/:address/orders/:orderId', async (req, reply) => {
    const p = parse(OrderMatchesParams, req.params, reply); if (!p) return

    const cacheKey = `order-matches:${p.address}:${p.orderId}`
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    const orderRes = await pg.query(
      `SELECT order_id, trader_address, direction, amount_usdc, filled_amount,
              status, payout_usdc, unmatched_refunded, placed_at
         FROM orders WHERE market_address = $1 AND order_id = $2`,
      [p.address, p.orderId],
    )
    if (!orderRes.rows[0]) return reply.code(404).send({ error: 'order not found' })
    const o = orderRes.rows[0]
    const isUp = o.direction === 'UP'

    const matchRes = await pg.query(
      `SELECT m.match_id, m.is_lp_match, om.matched_amount, m.entry_price, m.exit_price,
              m.settled, m.tied, m.up_won, m.emergency_refunded, m.settle_at, m.settled_at
         FROM order_matches om
         JOIN matches m ON m.market_address = om.market_address AND m.match_id = om.match_id
        WHERE om.market_address = $1 AND om.order_id = $2
        ORDER BY m.settle_at ASC`,
      [p.address, p.orderId],
    )

    const matches = matchRes.rows.map(m => ({
      matchId:      m.match_id,
      isLpMatch:    m.is_lp_match,
      amount:       parseFloat(m.matched_amount),
      entryPrice:   m.entry_price,
      exitPrice:    m.exit_price,
      settled:      m.settled,
      settleAt:     Math.floor(new Date(m.settle_at).getTime() / 1000),
      settledAt:    m.settled_at ? Math.floor(new Date(m.settled_at).getTime() / 1000) : null,
      // Mirrors profile.ts's WON_EXPR/TIED_EXPR, plus the emergency-refund
      // case those never had to consider.
      outcome: !m.settled            ? 'pending'
             : m.emergency_refunded  ? 'emergency_refunded'
             : m.tied                ? 'tied'
             : (isUp === m.up_won)   ? 'won'
             :                         'lost',
    }))

    const out = {
      orderId:           o.order_id,
      trader:            o.trader_address,
      direction:         o.direction,
      amount:            parseFloat(o.amount_usdc),
      filledAmount:      parseFloat(o.filled_amount),
      status:            o.status,
      payout:            o.payout_usdc !== null ? parseFloat(o.payout_usdc) : null,
      unmatchedRefunded: o.unmatched_refunded,
      matches,
    }

    await redis.setEx(cacheKey, 5, JSON.stringify(out))
    return out
  })
}
