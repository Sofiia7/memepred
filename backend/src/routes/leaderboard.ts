import { FastifyInstance } from 'fastify'
import { z }     from 'zod'
import { redis } from '../db/redis.js'
import { pg }    from '../db/pg.js'
import { parse } from '../lib/validate.js'

const LbQuery = z.object({
  period: z.enum(['weekly', 'monthly', 'alltime']).default('weekly'),
  limit:  z.coerce.number().int().min(1).max(200).default(100)
})

export async function leaderboardRoutes(app: FastifyInstance) {

  app.get('/', async (req, reply) => {
    const q = parse(LbQuery, req.query, reply); if (!q) return

    const cacheKey = `leaderboard:${q.period}:${q.limit}`
    const cached   = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    const intervals: Record<string, string> = {
      weekly:  '7 days',
      monthly: '30 days',
      alltime: '100 years'
    }
    const interval = intervals[q.period]

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
    `, [q.limit])

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
  })
}
