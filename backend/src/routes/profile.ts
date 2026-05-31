import { FastifyInstance } from 'fastify'
import { z }     from 'zod'
import { pg }    from '../db/pg.js'
import { redis } from '../db/redis.js'
import { zAddress, parse } from '../lib/validate.js'

const Params = z.object({ address: zAddress })

export async function profileRoutes(app: FastifyInstance) {

  app.get('/:address', async (req, reply) => {
    const p = parse(Params, req.params, reply); if (!p) return
    const addr = p.address.toLowerCase()

    const cacheKey = `profile:${addr}`
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    // Sprint 3.3: query orders directly. "Won" = order has payout > 0.
    // Volume uses filled_amount (what was actually at risk after partial
    // refunds), so a half-filled-then-refunded order doesn't inflate stats.
    const stats = await pg.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('SETTLED','CLAIMED'))
                                                                AS total_bets,
        COUNT(*) FILTER (WHERE status IN ('SETTLED','CLAIMED')
                          AND COALESCE(payout_usdc,0) > 0)      AS won_bets,
        COALESCE(SUM(filled_amount), 0)                          AS total_volume,
        COALESCE(SUM(
          CASE
            WHEN status = 'CLAIMED' THEN COALESCE(payout_usdc, 0) - filled_amount
            WHEN status = 'SETTLED' THEN COALESCE(payout_usdc, 0) - filled_amount
            ELSE 0
          END
        ), 0)                                                    AS profit
      FROM orders
      WHERE trader_address = $1
    `, [addr])

    const streak = await pg.query(
      `SELECT current_streak, max_streak FROM traders WHERE trader_address = $1`,
      [addr],
    )

    const badges = await pg.query(
      'SELECT badge_id, minted_at FROM minted_badges WHERE trader_address = $1 ORDER BY badge_id',
      [addr],
    )

    const recentOrders = await pg.query(`
      SELECT o.market_address, o.order_id, o.direction, o.amount_usdc,
             o.filled_amount, o.status,
             o.payout_usdc, o.placed_at, o.settled_at, o.claimed_at,
             o.feed_symbol,
             COALESCE(payout_usdc, 0) > 0 AS won
      FROM orders o
      WHERE o.trader_address = $1
      ORDER BY o.placed_at DESC
      LIMIT 50
    `, [addr])

    const s  = stats.rows[0]
    const st = streak.rows[0] ?? { current_streak: 0, max_streak: 0 }
    const totalBets = parseInt(s.total_bets)
    const wonBets   = parseInt(s.won_bets)

    const profile = {
      address:       addr,
      totalBets,
      wonBets,
      accuracy:      totalBets > 0 ? Math.round((wonBets / totalBets) * 1000) / 10 : 0,
      totalVolume:   parseFloat(s.total_volume),
      profit:        parseFloat(s.profit),
      currentStreak: parseInt(st.current_streak ?? 0),
      maxStreak:     parseInt(st.max_streak ?? 0),
      badges:        badges.rows,
      recentOrders:  recentOrders.rows,
      // back-compat alias
      recentBets:    recentOrders.rows,
    }

    await redis.setEx(cacheKey, 30, JSON.stringify(profile))
    return profile
  })
}
