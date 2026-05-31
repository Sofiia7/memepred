import { FastifyInstance } from 'fastify'
import { z }     from 'zod'
import { pg }    from '../db/pg.js'
import { redis } from '../db/redis.js'
import { zAddress, zFeedId, zStatus, parse } from '../lib/validate.js'

const ListQuery = z.object({
  status: zStatus.optional(),
  feedId: zFeedId.optional()
})

const ByAddressParams = z.object({ address: zAddress })

export async function marketsRoutes(app: FastifyInstance) {

  app.get('/', async (req, reply) => {
    const q = parse(ListQuery, req.query, reply); if (!q) return

    const cacheKey = `markets:${q.status || 'all'}:${q.feedId || 'all'}`
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    let query = 'SELECT * FROM markets WHERE 1=1'
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
      closeTime:   Math.floor(new Date(r.close_time).getTime() / 1000),
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

    const result = await pg.query('SELECT * FROM markets WHERE market_address = $1', [p.address])
    if (!result.rows[0]) return reply.code(404).send({ error: 'market not found' })

    const r = result.rows[0]
    const market = {
      address:    r.market_address,
      feedId:     r.feed_id,
      feedSymbol: r.feed_symbol,
      duration:   r.duration_secs,
      openTime:   Math.floor(new Date(r.open_time).getTime() / 1000),
      closeTime:  Math.floor(new Date(r.close_time).getTime() / 1000),
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

  // 24h aggregate stats: total bet volume + per-symbol latest price & 24h change %
  app.get('/stats', async () => {
    const cacheKey = 'markets:stats:24h'
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    // Total volume (sum of filled USDC at risk in last 24h)
    const volRes = await pg.query<{ vol: string }>(
      `SELECT COALESCE(SUM(filled_amount), 0)::text AS vol
         FROM orders
        WHERE placed_at >= NOW() - INTERVAL '24 hours'`,
    )
    const volume24h = parseFloat(volRes.rows[0]?.vol ?? '0')

    // Per-symbol: latest price + price closest to 24h ago
    const sym = await pg.query<{
      symbol: string; latest: string; prior: string | null
    }>(
      `WITH latest AS (
         SELECT DISTINCT ON (symbol) symbol, price, recorded_at
           FROM price_history
          ORDER BY symbol, recorded_at DESC
       ),
       prior AS (
         SELECT DISTINCT ON (symbol) symbol, price
           FROM price_history
          WHERE recorded_at <= NOW() - INTERVAL '24 hours'
          ORDER BY symbol, recorded_at DESC
       )
       SELECT l.symbol,
              l.price::text  AS latest,
              p.price::text  AS prior
         FROM latest l
         LEFT JOIN prior p USING (symbol)`
    )

    const symbols = sym.rows.map(r => {
      const latest = parseFloat(r.latest)
      const prior = r.prior !== null ? parseFloat(r.prior) : null
      const chg24h = prior && prior > 0 ? ((latest - prior) / prior) * 100 : 0
      return { symbol: r.symbol, price: latest, chg24h }
    })

    const out = { volume24h, symbols }
    await redis.setEx(cacheKey, 30, JSON.stringify(out))
    return out
  })
}
