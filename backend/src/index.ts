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
import poolRoutes            from './routes/pool.js'
import { pg }                from './db/pg.js'
import { runMigrations }     from './db/migrate.js'
import { redis }             from './db/redis.js'
import { PORT }              from './config.js'

const app = Fastify({ logger: true })

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

await app.register(marketsRoutes,     { prefix: '/api/markets' })
await app.register(candlesRoutes,     { prefix: '/api/candles' })
await app.register(leaderboardRoutes, { prefix: '/api/leaderboard' })
await app.register(profileRoutes,     { prefix: '/api/profile' })
await app.register(referralRoutes,    { prefix: '/api/referral' })
await app.register(poolRoutes)        // mounts /api/pool/*

app.get('/health', async () => ({ status: 'ok', ts: Date.now() }))

// ── GEO API (Worker-only) ──────────────────────────────────
// Cloudflare Worker fronts the API; the worker injects X-Country and
// proves authenticity with WORKER_SECRET. Direct calls without the secret
// are rejected so clients can't spoof their country.
app.get('/api/geo', async (req, reply) => {
  const expected = process.env.WORKER_SECRET
  const provided = req.headers['x-worker-secret'] as string | undefined
  if (!expected || provided !== expected) {
    return reply.status(401).send({ error: 'unauthorized' })
  }
  const country = (req.headers['x-country'] as string) || 'XX'
  return { country }
})

try {
  await pg.connect()
  await runMigrations()
  await redis.connect()
  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`MemePred API listening on port ${PORT}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
