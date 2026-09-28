import { FastifyInstance } from 'fastify'
import { z }     from 'zod'
import { pg }    from '../db/pg.js'
import { redis } from '../db/redis.js'
import { zAddress, parse } from '../lib/validate.js'

const Params = z.object({ address: zAddress })

/**
 * Did this order win? Derived from settled matches, NOT from payout_usdc.
 *
 * payout_usdc is only written by the indexer's Claimed handler, so
 * `COALESCE(payout_usdc,0) > 0` — what this used to say — was false for every
 * order that had won but not yet been claimed. That fed three visible bugs at
 * once: the profile counted a pending winner as a loss, profit showed a
 * full-stake loss, and Portfolio rendered "LOST" with no claim button (the
 * button's own condition required won === true, so it could never appear —
 * by the time payout_usdc existed, the order was already CLAIMED).
 *
 * Expects the orders table to be aliased `o`.
 */
/**
 * NOT m.emergency_refunded matters as of audit A03/A04 (2026-09-28): before
 * that fix, an emergency-refunded match's `settled` stayed FALSE in this
 * table forever, so it could never satisfy this EXISTS at all. Now that it
 * correctly reads TRUE, up_won - never set by emergencyRefundMatch, so it
 * keeps its zero-initialized FALSE - would otherwise read as a real win for
 * every DOWN order this happens to and a real loss for every UP one. A
 * refund is neither.
 */
const WON_EXPR = `EXISTS (
  SELECT 1
  FROM order_matches om
  JOIN matches m
    ON m.market_address = om.market_address AND m.match_id = om.match_id
  WHERE om.market_address = o.market_address
    AND om.order_id       = o.order_id
    AND m.settled
    AND NOT m.tied
    AND NOT m.emergency_refunded
    AND ((o.direction = 'UP') = m.up_won)
)`

/**
 * Whether ANY of this order's matches tied. A tie is neither a win nor a
 * loss - the frontend needs to tell it apart from both rather than folding
 * it into whichever WON_EXPR would otherwise report (false, i.e. "lost").
 */
const TIED_EXPR = `EXISTS (
  SELECT 1
  FROM order_matches om
  JOIN matches m
    ON m.market_address = om.market_address AND m.match_id = om.match_id
  WHERE om.market_address = o.market_address
    AND om.order_id       = o.order_id
    AND m.tied
)`

/**
 * Realised PnL across an order's settled matches: each match stakes `amount`
 * per side, so the winner nets +amount and the loser -amount. Reads from
 * matches rather than payout_usdc for the same reason as WON_EXPR.
 *
 * Approximation: ignores LP_TAKER_FEE_BPS (1%, charged only when the LP is the
 * counterparty and the user wins) AND the market's own protocol feeBps, so a
 * win reads higher than the actual on-chain payout by however much fee was
 * taken from that match's pool. Deliberate — the exact figure lives on-chain
 * in Order.payout, and a profile stat that is a bit optimistic beats one that
 * reports every unclaimed winner as a total loss. See audit U07 for the fuller
 * fix (a real ledger over stake/refunds/winnings/fees); this stays an
 * approximation until then.
 *
 * emergency_refunded matches like tied: audit A03/A04 made `settled` finally
 * read TRUE for them, and up_won's meaningless default (never set by
 * emergencyRefundMatch) would otherwise misprice a refund as a real win or
 * loss - see WON_EXPR's comment for the same reasoning.
 */
const PNL_EXPR = `COALESCE((
  SELECT SUM(CASE WHEN m.tied OR m.emergency_refunded THEN 0
                  WHEN (o.direction = 'UP') = m.up_won
                  THEN m.amount_usdc ELSE -m.amount_usdc END)
  FROM order_matches om
  JOIN matches m
    ON m.market_address = om.market_address AND m.match_id = om.match_id
  WHERE om.market_address = o.market_address
    AND om.order_id       = o.order_id
    AND m.settled
), 0)`

export async function profileRoutes(app: FastifyInstance) {

  app.get('/:address', async (req, reply) => {
    const p = parse(Params, req.params, reply); if (!p) return
    const addr = p.address.toLowerCase()

    const cacheKey = `profile:${addr}`
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    // Sprint 3.3: query orders directly.
    // Volume uses filled_amount (what was actually at risk after partial
    // refunds), so a half-filled-then-refunded order doesn't inflate stats.
    const stats = await pg.query(`
      SELECT
        COUNT(*) FILTER (WHERE o.status IN ('SETTLED','CLAIMED'))  AS total_bets,
        COUNT(*) FILTER (WHERE o.status IN ('SETTLED','CLAIMED')
                          AND ${WON_EXPR})                         AS won_bets,
        COALESCE(SUM(o.filled_amount), 0)                          AS total_volume,
        COALESCE(SUM(${PNL_EXPR}), 0)                              AS profit
      FROM orders o
      WHERE o.trader_address = $1
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
             -- The UI distinguishes three states and keys its claim button off
             -- them, so this has to be tri-state: NULL while the bet is still
             -- running, then a real boolean. It used to be a plain
             -- "payout > 0", which is never NULL, so the UI pending branch was
             -- unreachable and every live bet rendered as LOST.
             CASE WHEN o.status IN ('PENDING', 'MATCHED') THEN NULL
                  ELSE ${WON_EXPR}
             END                          AS won,
             CASE WHEN o.status IN ('PENDING', 'MATCHED') THEN NULL
                  ELSE ${TIED_EXPR}
             END                          AS tied,
             -- The frontend Bet type expects "claimed"; the API only ever sent
             -- claimed_at, so the UI negation was always true and an
             -- already-claimed order stayed in the "ready to claim" list.
             (o.claimed_at IS NOT NULL)   AS claimed
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
