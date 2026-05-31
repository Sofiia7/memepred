import { FastifyInstance } from 'fastify'
import { z }     from 'zod'
import { redis } from '../db/redis.js'
import { pg }    from '../db/pg.js'
import { parse } from '../lib/validate.js'

const LbQuery = z.object({
  period: z.enum(['weekly', 'monthly', 'alltime']).default('weekly'),
  limit:  z.coerce.number().int().min(1).max(200).default(100),
})

// Enum → string literal map. Enum validation above means the value is one
// of THREE fixed strings, safe to interpolate even though SQL doesn't allow
// parameterizing INTERVAL.
const INTERVALS: Record<string, string> = {
  weekly:  '7 days',
  monthly: '30 days',
  alltime: '100 years',
}

export async function leaderboardRoutes(app: FastifyInstance) {

  app.get('/', async (req, reply) => {
    const q = parse(LbQuery, req.query, reply); if (!q) return

    const cacheKey = `leaderboard:${q.period}:${q.limit}`
    const cached   = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    const interval: string = INTERVALS[q.period as string] ?? '7 days'

    // Sprint 3.3: rewrites the v1 `bets` query against `orders`.
    // total_bets = orders that have reached SETTLED or CLAIMED in the period.
    // won_bets   = same set, but payout > 0.
    // total_volume = SUM(filled_amount) — risk that was actually at stake.
    // profit       = SUM(payout - filled_amount) on settled/claimed orders.
    // streak       = max current streak on the traders aggregate table.
    const result = await pg.query(`
      SELECT
        o.trader_address,
        COUNT(*)                                                  AS total_bets,
        COUNT(*) FILTER (WHERE COALESCE(o.payout_usdc, 0) > 0)    AS won_bets,
        ROUND(
          COUNT(*) FILTER (WHERE COALESCE(o.payout_usdc, 0) > 0)::numeric
          / NULLIF(COUNT(*), 0) * 100, 1
        )                                                          AS accuracy_pct,
        COALESCE(SUM(o.filled_amount), 0)                          AS total_volume,
        COALESCE(SUM(COALESCE(o.payout_usdc, 0) - o.filled_amount), 0)
                                                                   AS profit,
        COALESCE(MAX(t.current_streak), 0)                         AS streak
      FROM orders o
      LEFT JOIN traders t ON t.trader_address = o.trader_address
      WHERE o.status IN ('SETTLED', 'CLAIMED')
        AND o.settled_at > NOW() - INTERVAL '${interval}'
      GROUP BY o.trader_address
      HAVING COUNT(*) >= 5
      ORDER BY accuracy_pct DESC, total_volume DESC
      LIMIT $1
    `, [q.limit])

    const board = result.rows.map((r, i) => ({
      rank:      i + 1,
      address:   r.trader_address,
      totalBets: parseInt(r.total_bets),
      wonBets:   parseInt(r.won_bets),
      accuracy:  parseFloat(r.accuracy_pct),
      volume:    parseFloat(r.total_volume),
      profit:    parseFloat(r.profit),
      streak:    parseInt(r.streak),
    }))

    await redis.setEx(cacheKey, 60, JSON.stringify(board))
    return board
  })
}
