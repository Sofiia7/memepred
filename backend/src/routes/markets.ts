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

    const bets = await pg.query(
      `SELECT trader_address, direction, amount_usdc, won, payout_usdc, placed_at
       FROM bets WHERE market_address = $1 ORDER BY placed_at DESC`,
      [p.address]
    )

    const out = { ...market, bets: bets.rows }
    await redis.setEx(cacheKey, 10, JSON.stringify(out))
    return out
  })
}
