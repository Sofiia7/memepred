import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pg } from '../db/pg.js'
import { CHAIN_PROFILE } from '../chainProfile.js'
import { andFactory } from '../lib/marketScope.js'
import { parse } from '../lib/validate.js'

/**
 * The pool feed: what the keeper has seen, what it decided, and why.
 *
 * On Base there is nothing to serve - a feed there is a symbol somebody
 * whitelisted, and the list of them is three items long and never changes. On
 * Robinhood Chain 496 pools are created a day and the interesting question is
 * which of them can be traded and which cannot, so this is the rhc profile's
 * front page.
 *
 * `reason` is served verbatim rather than mapped to a code. It is the same
 * string poolWatcher logged when it made the decision, so "why is there no
 * market on my token" has one answer everywhere it is asked, and adding a new
 * rejection reason does not mean teaching three layers about it.
 */
const ListQuery = z.object({
  status: z.enum(['PENDING', 'READY', 'ONBOARDED', 'REJECTED']).optional(),
  /** Only pools with at least this much WETH behind them, in whole ether. */
  minDepth: z.coerce.number().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

export async function poolsRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const q = parse(ListQuery, req.query, reply)
    if (!q) return

    // Empty rather than an error on base: a client that renders this feed
    // should show "no pools here" on a chain that has none, not a failure.
    if (CHAIN_PROFILE.name !== 'rhc') {
      return { chainId: CHAIN_PROFILE.chain.id, poolBacked: false, pools: [] }
    }

    const params: unknown[] = [CHAIN_PROFILE.chain.id]
    let sql = `
      SELECT c.pool_address, c.token_address, c.token_symbol, c.fee_tier,
             c.status, c.reason, c.weth_depth, c.cardinality,
             c.first_seen_at, c.last_checked_at,
             COALESCE(m.durations, '{}') AS durations
        FROM pool_candidates c
        LEFT JOIN LATERAL (
          SELECT array_agg(mk.duration_secs ORDER BY mk.duration_secs) AS durations
            FROM markets mk
           WHERE mk.feed_id = '0x' || lpad(substr(c.pool_address, 3), 64, '0')
             AND mk.chain_id = c.chain_id${andFactory('mk.factory_address')}
        ) m ON TRUE
       WHERE c.chain_id = $1`

    if (q.status) {
      params.push(q.status)
      sql += ` AND c.status = $${params.length}`
    }
    if (q.minDepth !== undefined) {
      params.push(q.minDepth)
      sql += ` AND c.weth_depth >= $${params.length}`
    }

    // Deepest first: on a chain producing hundreds of pools a day, depth is
    // the only ordering a trader cares about, and it is also what decides
    // whether the price can be pushed.
    params.push(q.limit ?? 50)
    sql += ` ORDER BY c.weth_depth DESC NULLS LAST, c.first_seen_at DESC LIMIT $${params.length}`

    const r = await pg.query(sql, params)
    const now = Date.now()

    return {
      chainId: CHAIN_PROFILE.chain.id,
      poolBacked: true,
      pools: r.rows.map((p) => ({
        pool: p.pool_address,
        token: p.token_address,
        symbol: p.token_symbol,
        feeTier: p.fee_tier,
        status: p.status,
        reason: p.reason,
        wethDepth: p.weth_depth === null ? null : parseFloat(p.weth_depth),
        cardinality: p.cardinality,
        ageSec: Math.floor((now - new Date(p.first_seen_at).getTime()) / 1000),
        lastCheckedSec:
          p.last_checked_at === null
            ? null
            : Math.floor((now - new Date(p.last_checked_at).getTime()) / 1000),
        marketDurations: (p.durations as number[]) ?? [],
      })),
    }
  })
}
