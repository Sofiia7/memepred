import { config } from 'dotenv'
config()

import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { marketsRoutes }     from './routes/markets.js'
import { candlesRoutes }     from './routes/candles.js'
import { leaderboardRoutes } from './routes/leaderboard.js'
import { profileRoutes }     from './routes/profile.js'
import { referralRoutes }    from './routes/referral.js'
import { pg }    from './db/pg.js'
import { redis } from './db/redis.js'
import { PORT }  from './config.js'

const app = Fastify({ logger: true })

// ── PLUGINS ────────────────────────────────────────────────
await app.register(cors, {
  origin: [
    'https://memepred.xyz',
    'http://localhost:3000',
    'http://localhost:5173'
  ]
})

await app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute'
})

// ── ROUTES ─────────────────────────────────────────────────
await app.register(marketsRoutes,     { prefix: '/api/markets' })
await app.register(candlesRoutes,     { prefix: '/api/candles' })
await app.register(leaderboardRoutes, { prefix: '/api/leaderboard' })
await app.register(profileRoutes,     { prefix: '/api/profile' })
await app.register(referralRoutes,    { prefix: '/api/referral' })

// ── HEALTH ─────────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok', ts: Date.now() }))

// ── GEO API ────────────────────────────────────────────────
app.get('/api/geo', async (req) => {
  const country = (req.headers['x-country'] as string) || 'XX'
  return { country }
})

// ── START ──────────────────────────────────────────────────
try {
  await pg.connect()
  await redis.connect()
  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`MemePred API listening on port ${PORT}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
