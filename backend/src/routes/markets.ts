import { FastifyInstance } from 'fastify'
import { pg } from '../db/pg.js'
import { redis } from '../db/redis.js'

export async function marketsRoutes(app: FastifyInstance) {

  /**
   * GET /api/markets?status=OPEN&feedId=0x...
   */
  app.get<{ Querystring: { status?: string; feedId?: string } }>(
    '/',
    async (req) => {
      const { status, feedId } = req.query
      const cacheKey = `markets:${status || 'all'}:${feedId || 'all'}`
      const cached = await redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

      let query = 'SELECT * FROM markets WHERE 1=1'
      const params: any[] = []

      if (status) {
        params.push(status)
        query += ` AND status = $${params.length}`
      }
      if (feedId) {
        params.push(feedId)
        query += ` AND feed_id = $${params.length}`
      }

      query += ' ORDER BY open_time DESC LIMIT 50'

      const result = await pg.query(query, params)

      const markets = result.rows.map(r => ({
        address:     r.market_address,
        feedId:      r.feed_id,
        feedSymbol:  r.feed_symbol,
        duration:    r.duration_secs,
        openTime:    Math.floor(new Date(r.open_time).getTime() / 1000),
        closeTime:   Math.floor(new Date(r.close_time).getTime() / 1000),
        entryPrice:  parseFloat(r.entry_price),
        exitPrice:   r.exit_price ? parseFloat(r.exit_price) : null,
        status:      r.status,
        upWon:       r.up_won,
        upPool:      parseFloat(r.up_pool),
        downPool:    parseFloat(r.down_pool),
      }))

      await redis.setEx(cacheKey, 15, JSON.stringify(markets))
      return markets
    }
  )

  /**
   * GET /api/markets/:address
   */
  app.get<{ Params: { address: string } }>(
    '/:address',
    async (req, reply) => {
      const { address } = req.params
      const cacheKey = `market:${address}`
      const cached = await redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

      const result = await pg.query(
        'SELECT * FROM markets WHERE market_address = $1',
        [address.toLowerCase()]
      )

      if (!result.rows[0]) return reply.code(404).send({ error: 'market not found' })

      const r = result.rows[0]
      const market = {
        address:    r.market_address,
        feedId:     r.feed_id,
        feedSymbol: r.feed_symbol,
        duration:   r.duration_secs,
        openTime:   Math.floor(new Date(r.open_time).getTime() / 1000),
        closeTime:  Math.floor(new Date(r.close_time).getTime() / 1000),
        entryPrice: parseFloat(r.entry_price),
        exitPrice:  r.exit_price ? parseFloat(r.exit_price) : null,
        status:     r.status,
        upWon:      r.up_won,
        upPool:     parseFloat(r.up_pool),
        downPool:   parseFloat(r.down_pool),
      }

      // Also get bets for this market
      const bets = await pg.query(
        `SELECT trader_address, direction, amount_usdc, won, payout_usdc, placed_at
         FROM bets WHERE market_address = $1 ORDER BY placed_at DESC`,
        [address.toLowerCase()]
      )

      await redis.setEx(cacheKey, 10, JSON.stringify({ ...market, bets: bets.rows }))
      return { ...market, bets: bets.rows }
    }
  )
}
