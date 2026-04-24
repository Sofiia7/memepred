import { FastifyInstance } from 'fastify'
import { redis } from '../db/redis.js'
import { pg }    from '../db/pg.js'

export async function leaderboardRoutes(app: FastifyInstance) {

  /**
   * GET /api/leaderboard?period=weekly&limit=100
   */
  app.get<{ Querystring: { period?: string; limit?: number } }>(
    '/',
    async (req) => {
      const period = req.query.period || 'weekly'
      const limit  = Math.min(req.query.limit || 100, 200)

      const cacheKey = `leaderboard:${period}:${limit}`
      const cached   = await redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

      const intervals: Record<string, string> = {
        weekly:  '7 days',
        monthly: '30 days',
        alltime: '100 years'
      }
      const interval = intervals[period] || '7 days'

      const result = await pg.query(`
        SELECT
          trader_address,
          COUNT(*)                                          AS total_bets,
          COUNT(*) FILTER (WHERE won = true)               AS won_bets,
          ROUND(
            COUNT(*) FILTER (WHERE won = true)::numeric
            / NULLIF(COUNT(*), 0) * 100, 1
          )                                                AS accuracy_pct,
          COALESCE(SUM(amount_usdc), 0)                    AS total_volume,
          COALESCE(SUM(CASE WHEN won THEN payout_usdc - amount_usdc
                            ELSE -amount_usdc END), 0)     AS profit,
          MAX(current_streak)                              AS streak
        FROM bets
        WHERE settled_at > NOW() - INTERVAL '${interval}'
        GROUP BY trader_address
        HAVING COUNT(*) >= 5
        ORDER BY accuracy_pct DESC, total_volume DESC
        LIMIT $1
      `, [limit])

      const board = result.rows.map((r, i) => ({
        rank:        i + 1,
        address:     r.trader_address,
        totalBets:   parseInt(r.total_bets),
        wonBets:     parseInt(r.won_bets),
        accuracy:    parseFloat(r.accuracy_pct),
        volume:      parseFloat(r.total_volume),
        profit:      parseFloat(r.profit),
        streak:      parseInt(r.streak)
      }))

      await redis.setEx(cacheKey, 60, JSON.stringify(board))
      return board
    }
  )
}
