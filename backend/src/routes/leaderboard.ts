import { FastifyInstance } from 'fastify'
import { z }     from 'zod'
import { redis } from '../db/redis.js'
import { pg }    from '../db/pg.js'
import { parse } from '../lib/validate.js'

const LbQuery = z.object({
  // 'daily' added: the frontend's 24H tab (Leaderboard.tsx) has always sent
  // period=daily, which this enum rejected with a 400 - the tab could never
  // show anything but "NO DATA YET" regardless of how much volume there was.
  period: z.enum(['daily', 'weekly', 'monthly', 'alltime']).default('weekly'),
  limit:  z.coerce.number().int().min(1).max(200).default(100),
})

/**
 * Minimum settled orders before a trader is ranked at all.
 */
const MIN_SETTLED_BETS = Number(process.env.LEADERBOARD_MIN_BETS ?? '5')

/**
 * Minimum number of DISTINCT peer counterparties before a trader is ranked.
 *
 * Anti-wash control. Peer matches carry a 0% fee (OrderbookMarket.feeBps is 0),
 * so two wallets can trade against each other indefinitely for the price of
 * gas. Requiring several distinct opponents means a two-wallet pair — the
 * cheapest and most common setup — never appears, regardless of how much
 * volume it generates. LP matches don't count toward this: you cannot wash
 * against the pool, and pool exposure is already bounded per trader by
 * MAX_TRADER_LP_EXPOSURE.
 *
 * Tunable because a brand-new deployment has few users and a strict threshold
 * would leave the board empty; relax it for launch week, then restore.
 */
const MIN_DISTINCT_OPPONENTS = Number(process.env.LEADERBOARD_MIN_OPPONENTS ?? '3')

// Enum → string literal map. Enum validation above means the value is one
// of THREE fixed strings, safe to interpolate even though SQL doesn't allow
// parameterizing INTERVAL.
const INTERVALS: Record<string, string> = {
  daily:   '1 day',
  weekly:  '7 days',
  monthly: '30 days',
  alltime: '100 years',
}

export async function leaderboardRoutes(app: FastifyInstance) {

  app.get('/', async (req, reply) => {
    const q = parse(LbQuery, req.query, reply); if (!q) return

    // v2 — ranking key and payload shape both changed; a bare `leaderboard:`
    // key would keep serving the old accuracy-ranked rows (without
    // `opponents`) from Redis until every entry aged out.
    const cacheKey = `leaderboard:v2:${q.period}:${q.limit}`
    const cached   = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    const interval: string = INTERVALS[q.period as string] ?? '7 days'

    // Sprint 3.3: rewrites the v1 `bets` query against `orders`.
    // total_bets = orders that have reached SETTLED or CLAIMED in the period.
    // won_bets   = same set, but payout > 0.
    // total_volume = SUM(filled_amount) — risk that was actually at stake.
    // profit       = SUM(payout - filled_amount) on settled/claimed orders.
    // streak       = max current streak on the traders aggregate table.
    //
    // Sprint 5.6 — ranking is now net realised PnL, not accuracy/volume.
    //
    // The previous key was `accuracy_pct DESC, total_volume DESC`, and both
    // halves were free to farm: peer matches take 0% fee, so two wallets can
    // trade against each other all day for gas. One wallet is fed every win
    // and reaches 100% accuracy; the pair generates unlimited volume for the
    // tiebreak. Neither number costs the operator anything to fake, so the
    // board ranked whoever was most willing to run a script.
    //
    // Net PnL is structurally immune to that: a wash pair sums to zero by
    // construction — one side's payout is the other side's stake — so it can
    // never climb, no matter how many wallets or how much volume. Accuracy and
    // volume are still returned and still displayed; they're just no longer
    // what a place is awarded for. The distinct-counterparty floor below is
    // defence in depth, not the primary control.
    const result = await pg.query(`
      WITH scored AS (
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
        HAVING COUNT(*) >= $2
      ),
      -- Distinct PEER counterparties per trader. For each match the trader was
      -- filled in, the opponent is whichever side of the match isn't theirs.
      -- LP matches are excluded: there is no counterparty to collude with.
      opponents AS (
        SELECT
          o.trader_address,
          COUNT(DISTINCT opp.trader_address) AS distinct_opponents
        FROM orders o
        JOIN order_matches om
          ON om.market_address = o.market_address
         AND om.order_id       = o.order_id
        JOIN matches m
          ON m.market_address = om.market_address
         AND m.match_id       = om.match_id
        JOIN orders opp
          ON opp.market_address = m.market_address
         AND opp.order_id = CASE WHEN m.up_order_id = o.order_id
                                 THEN m.down_order_id
                                 ELSE m.up_order_id END
        WHERE m.is_lp_match = FALSE
          AND o.status IN ('SETTLED', 'CLAIMED')
          AND o.settled_at > NOW() - INTERVAL '${interval}'
          AND opp.trader_address <> o.trader_address
        GROUP BY o.trader_address
      )
      SELECT
        s.*,
        COALESCE(op.distinct_opponents, 0) AS distinct_opponents
      FROM scored s
      LEFT JOIN opponents op ON op.trader_address = s.trader_address
      WHERE COALESCE(op.distinct_opponents, 0) >= $3
      ORDER BY s.profit DESC, s.accuracy_pct DESC, s.total_volume DESC
      LIMIT $1
    `, [q.limit, MIN_SETTLED_BETS, MIN_DISTINCT_OPPONENTS])

    const board = result.rows.map((r, i) => ({
      rank:      i + 1,
      address:   r.trader_address,
      totalBets: parseInt(r.total_bets),
      wonBets:   parseInt(r.won_bets),
      accuracy:  parseFloat(r.accuracy_pct),
      volume:    parseFloat(r.total_volume),
      profit:    parseFloat(r.profit),
      streak:    parseInt(r.streak),
      opponents: parseInt(r.distinct_opponents),
    }))

    await redis.setEx(cacheKey, 60, JSON.stringify(board))
    return board
  })
}
