import { FastifyInstance } from 'fastify'
import { z }     from 'zod'
import { redis } from '../db/redis.js'
import { pg }    from '../db/pg.js'
import { zAddress, zFeedId, zTF, zLimit, parse } from '../lib/validate.js'

const CandlesParams = z.object({ feedId: zFeedId })
const CandlesQuery  = z.object({ tf: zTF.default('5m'), limit: zLimit })

const ProbParams    = z.object({ marketAddress: zAddress })

export async function candlesRoutes(app: FastifyInstance) {

  app.get('/:feedId', async (req, reply) => {
    const p = parse(CandlesParams, req.params, reply); if (!p) return
    const q = parse(CandlesQuery,  req.query,  reply); if (!q) return

    const cacheKey = `candles:${p.feedId}:${q.tf}:${q.limit}`
    const cached   = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    const intervalMap: Record<string, string> = {
      '5m':  '5 minutes',
      '15m': '15 minutes',
      '1h':  '1 hour',
      '4h':  '4 hours',
      '1d':  '1 day'
    }
    const interval = intervalMap[q.tf]

    const result = await pg.query(`
      SELECT
        time_bucket($1, recorded_at) AS time,
        FIRST(price, recorded_at)    AS open,
        MAX(price)                   AS high,
        MIN(price)                   AS low,
        LAST(price, recorded_at)     AS close,
        COUNT(*)                     AS ticks
      FROM price_history
      WHERE feed_id = $2
        AND recorded_at > NOW() - INTERVAL '7 days'
      GROUP BY time
      ORDER BY time DESC
      LIMIT $3
    `, [interval, p.feedId, q.limit])

    const candles = result.rows.reverse().map(r => ({
      time:  Math.floor(new Date(r.time).getTime() / 1000),
      open:  parseFloat(r.open),
      high:  parseFloat(r.high),
      low:   parseFloat(r.low),
      close: parseFloat(r.close)
    }))

    await redis.setEx(cacheKey, 30, JSON.stringify(candles))
    return candles
  })

  app.get('/:marketAddress/prob-history', async (req, reply) => {
    const p = parse(ProbParams, req.params, reply); if (!p) return

    const cacheKey = `prob:${p.marketAddress}`
    const cached   = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    const result = await pg.query(`
      SELECT
        snapshot_at,
        up_pool,
        down_pool,
        CASE WHEN (up_pool + down_pool) = 0 THEN 50
             ELSE ROUND(up_pool * 100.0 / (up_pool + down_pool), 1)
        END AS up_pct
      FROM prob_snapshots
      WHERE market_address = $1
      ORDER BY snapshot_at ASC
    `, [p.marketAddress])

    const history = result.rows.map(r => ({
      ts:     Math.floor(new Date(r.snapshot_at).getTime() / 1000),
      upPct:  parseFloat(r.up_pct),
      upPool: parseFloat(r.up_pool),
      dnPool: parseFloat(r.down_pool)
    }))

    await redis.setEx(cacheKey, 10, JSON.stringify(history))
    return history
  })
}
