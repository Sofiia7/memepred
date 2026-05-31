import { FastifyInstance } from 'fastify'
import { z }     from 'zod'
import { pg }    from '../db/pg.js'
import { redis } from '../db/redis.js'
import { zAddress, parse } from '../lib/validate.js'

const AddrParams = z.object({ address: zAddress })
// Referral codes are bytes6 → 12 hex chars (optionally 0x-prefixed).
const CodeParams = z.object({ code: z.string().regex(/^(0x)?[a-fA-F0-9]{12}$/, 'invalid code') })

export async function referralRoutes(app: FastifyInstance) {

  app.get('/:address', async (req, reply) => {
    const p = parse(AddrParams, req.params, reply); if (!p) return

    const result = await pg.query(`
      SELECT
        COUNT(*)                        AS referral_count,
        COALESCE(SUM(r.bet_volume), 0)  AS total_volume,
        COALESCE(SUM(r.earned_usdc), 0) AS total_earned
      FROM referrals r
      WHERE r.referrer_address = $1
    `, [p.address])

    const claimable = await pg.query(`
      SELECT COALESCE(SUM(amount), 0) AS claimable
      FROM referral_earnings
      WHERE referrer_address = $1 AND claimed = false
    `, [p.address])

    return {
      referralCount: parseInt(result.rows[0].referral_count),
      totalVolume:   parseFloat(result.rows[0].total_volume),
      totalEarned:   parseFloat(result.rows[0].total_earned),
      claimable:     parseFloat(claimable.rows[0].claimable)
    }
  })

  app.get('/resolve/:code', async (req, reply) => {
    const p = parse(CodeParams, req.params, reply); if (!p) return

    const cacheKey = `refcode:${p.code}`
    const cached   = await redis.get(cacheKey)
    if (cached) return { referrer: cached }

    const result = await pg.query(
      'SELECT referrer_address FROM ref_codes WHERE code = $1',
      [p.code]
    )
    if (!result.rows[0]) return reply.code(404).send({ error: 'code not found' })

    const referrer = result.rows[0].referrer_address
    await redis.setEx(cacheKey, 3600, referrer)
    return { referrer }
  })

  app.get('/list/:address', async (req, reply) => {
    const p = parse(AddrParams, req.params, reply); if (!p) return

    // Sprint 3.3: volume = SUM(filled_amount) on the referee's orders. We
    // multiply by feeBps × referrerShare to estimate earned, matching the
    // FeeDistributor split (0.5% × 40% by default).
    const result = await pg.query(`
      SELECT
        r.referee_address,
        r.registered_at,
        COALESCE(SUM(o.filled_amount), 0) AS volume,
        COALESCE(SUM(o.filled_amount * 0.005 * 0.40), 0) AS earned
      FROM referrals r
      LEFT JOIN orders o ON o.trader_address = r.referee_address
      WHERE r.referrer_address = $1
      GROUP BY r.referee_address, r.registered_at
      ORDER BY volume DESC
      LIMIT 50
    `, [p.address])

    return result.rows
  })
}
