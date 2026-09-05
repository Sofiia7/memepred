/**
 * First import, and it has to be an import rather than a call.
 *
 * ES module imports are hoisted above top-level statements, so the previous
 * `import { config } from 'dotenv'; config()` ran AFTER every other import had
 * already been evaluated - including db/pg.ts, which reads DATABASE_URL at
 * module scope through config.ts. The API therefore started with no database
 * password and died on a SASL error that named neither dotenv nor the cause.
 *
 * `dotenv/config` is a side-effecting import, so it is hoisted in order and
 * runs first, and it honours DOTENV_CONFIG_PATH - which is how a second chain's
 * profile gets loaded. Unset, it reads .env from the cwd exactly as before.
 * keeper/index.ts has always done it this way, which is why the keeper worked
 * against the rhc profile and the API did not.
 */
import 'dotenv/config'

import Fastify from 'fastify'
import { marketsRoutes }     from './routes/markets.js'
import { candlesRoutes }     from './routes/candles.js'
import { leaderboardRoutes } from './routes/leaderboard.js'
import { profileRoutes }     from './routes/profile.js'
import { referralRoutes }    from './routes/referral.js'
import poolRoutes            from './routes/pool.js'
import { poolsRoutes }        from './routes/pools.js'
import { keeperHealthRoutes } from './routes/keeperHealth.js'
import { oracleRoutes }      from './routes/oracle.js'
import { pg }                from './db/pg.js'
import { runMigrations }     from './db/migrate.js'
import { redis }             from './db/redis.js'
import { markUserActivity }  from './lib/activity.js'
import { registerHttpPlugins, DEFAULT_ORIGINS } from './lib/httpPlugins.js'
import { fetchPayload, fetchPrice } from './lib/redstone.js'
import { PORT, FEED_SYMBOLS } from './config.js'

const app = Fastify({ logger: true })

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean)

// CORS, rate limiting and the user-presence hook - see lib/httpPlugins.ts.
// They live there so `app.inject()` can exercise them without a Postgres and a
// Redis; this file cannot be imported by a test because it connects and
// listens at the top level.
await registerHttpPlugins(app, {
  corsOrigins:  allowedOrigins.length > 0 ? allowedOrigins : DEFAULT_ORIGINS,
  workerSecret: process.env.WORKER_SECRET,
  markActivity: markUserActivity,
})

await app.register(marketsRoutes,     { prefix: '/api/markets' })
await app.register(candlesRoutes,     { prefix: '/api/candles' })
await app.register(leaderboardRoutes, { prefix: '/api/leaderboard' })
await app.register(profileRoutes,     { prefix: '/api/profile' })
await app.register(referralRoutes,    { prefix: '/api/referral' })
await app.register(poolsRoutes,       { prefix: '/api/pools' })
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

// Proof that the edge and the origin still agree on WORKER_SECRET.
//
// The other two probes are edge-exempt so monitors can always reach them, which
// means a secret that drifted apart would 403 every product route while both
// monitors stayed green. This one is the mirror image: exempt from the country
// block at the edge, but subject to proof-of-edge here, so it answers only when
// the pairing works. It carries a status word and nothing else.
app.get('/health/edge', async () => ({ status: 'ok' }))

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
