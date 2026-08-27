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
import { keeperHealthRoutes } from './routes/keeperHealth.js'
import { oracleRoutes }      from './routes/oracle.js'
import { pg }                from './db/pg.js'
import { runMigrations }     from './db/migrate.js'
import { redis }             from './db/redis.js'
import { markUserActivity }  from './lib/activity.js'
import { makeClientKey }     from './lib/clientKey.js'
import { fetchPayload, fetchPrice } from './lib/redstone.js'
import { PORT, FEED_SYMBOLS } from './config.js'

const app = Fastify({ logger: true })

const DEFAULT_ORIGINS = [
  'https://flipthememe.com',
  'http://localhost:3000',
  'http://localhost:5173'
]
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
const corsOrigins = allowedOrigins.length > 0 ? allowedOrigins : DEFAULT_ORIGINS

await app.register(cors, { origin: corsOrigins })

// keyGenerator, not the default req.ip — see lib/clientKey.ts. Without it the
// whole API shares a single 100/min budget, because behind Caddy every request
// presents the same peer address.
await app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  keyGenerator: makeClientKey(process.env.WORKER_SECRET),
})

// ── USER-PRESENCE SIGNAL ───────────────────────────────────
// Stamps "a human is here" so the keeper can drop its on-chain Pyth push
// from every 30s to a slow heartbeat while nobody is around (see
// lib/activity.ts and keeper/onchainPriceRecorder.ts).
//
// Registered before the routes so it covers all of them. Health and
// monitoring endpoints are excluded deliberately: an uptime checker polling
// /health would otherwise keep the product permanently "busy" and quietly
// undo the entire saving.
const PRESENCE_IGNORED = new Set([
  '/health',
  '/api/keeper/health',
  '/api/geo',
  '/api/geo/config',
])
app.addHook('onRequest', async (req) => {
  if (req.method === 'OPTIONS') return
  if (PRESENCE_IGNORED.has(req.url.split('?')[0])) return
  await markUserActivity()
})

await app.register(marketsRoutes,     { prefix: '/api/markets' })
await app.register(candlesRoutes,     { prefix: '/api/candles' })
await app.register(leaderboardRoutes, { prefix: '/api/leaderboard' })
await app.register(profileRoutes,     { prefix: '/api/profile' })
await app.register(referralRoutes,    { prefix: '/api/referral' })
await app.register(poolRoutes)        // mounts /api/pool/*
await app.register(keeperHealthRoutes)// mounts /api/keeper/health

// RedStone prices for the frontend. No credential is involved - the gateway
// is public - but the browser would otherwise have to bundle
// @redstone-finance/protocol and its ethers v5 dependency just to concatenate
// a payload, and one cache here keeps our gateway request rate flat instead of
// scaling with concurrent visitors.
await app.register(oracleRoutes, {
  prefix:       '/api/oracle',
  allowedFeeds: new Set(FEED_SYMBOLS),
  fetchPayload,
  fetchPrice,
})

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
  console.log(`FlipTheMeme API listening on port ${PORT}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
