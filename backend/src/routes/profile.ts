import { FastifyInstance } from 'fastify'
import { pg }    from '../db/pg.js'
import { redis } from '../db/redis.js'

export async function profileRoutes(app: FastifyInstance) {

  /**
   * GET /api/profile/:address
   */
  app.get<{ Params: { address: string } }>(
    '/:address',
    async (req) => {
      const addr = req.params.address.toLowerCase()

      const cacheKey = `profile:${addr}`
      const cached = await redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

      // Stats
      const stats = await pg.query(`
        SELECT
          COUNT(*)                                          AS total_bets,
          COUNT(*) FILTER (WHERE won = true)               AS won_bets,
          COALESCE(SUM(amount_usdc), 0)                    AS total_volume,
          COALESCE(SUM(CASE WHEN won THEN payout_usdc - amount_usdc
                            ELSE -amount_usdc END), 0)     AS profit
        FROM bets
        WHERE trader_address = $1 AND settled_at IS NOT NULL
      `, [addr])

      // Streak
      const streak = await pg.query(
        'SELECT current_streak, max_streak FROM trader_streaks WHERE trader_address = $1',
        [addr]
      )

      // Badges
      const badges = await pg.query(
        'SELECT badge_id, minted_at FROM minted_badges WHERE trader_address = $1 ORDER BY badge_id',
        [addr]
      )

      // Recent bets
      const recentBets = await pg.query(`
        SELECT b.market_address, b.direction, b.amount_usdc, b.won, b.payout_usdc,
               b.placed_at, b.settled_at, m.feed_symbol
        FROM bets b
        JOIN markets m ON m.market_address = b.market_address
        WHERE b.trader_address = $1
        ORDER BY b.placed_at DESC
        LIMIT 20
      `, [addr])

      const s = stats.rows[0]
      const st = streak.rows[0] || { current_streak: 0, max_streak: 0 }

      const profile = {
        address:       addr,
        totalBets:     parseInt(s.total_bets),
        wonBets:       parseInt(s.won_bets),
        accuracy:      s.total_bets > 0 ? parseFloat((s.won_bets / s.total_bets * 100).toFixed(1)) : 0,
        totalVolume:   parseFloat(s.total_volume),
        profit:        parseFloat(s.profit),
        currentStreak: parseInt(st.current_streak),
        maxStreak:     parseInt(st.max_streak),
        badges:        badges.rows,
        recentBets:    recentBets.rows,
      }

      await redis.setEx(cacheKey, 30, JSON.stringify(profile))
      return profile
    }
  )
}
