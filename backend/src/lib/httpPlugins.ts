/**
 * The API's plugin stack: CORS, rate limiting, and the user-presence hook.
 *
 * Extracted from index.ts so it can be exercised by `app.inject()` without a
 * Postgres and a Redis. index.ts does top-level connects and a listen(), which
 * makes it unimportable from a test - so the three pieces of behaviour most
 * likely to break on a Fastify major upgrade were the three with no coverage
 * at all. This module is what the Fastify 4 -> 5 upgrade was verified against.
 */
import type { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { makeClientKey } from './clientKey.js'

export const DEFAULT_ORIGINS = [
  'https://flipthememe.com',
  'http://localhost:3000',
  'http://localhost:5173',
]

// ── USER-PRESENCE SIGNAL ───────────────────────────────────
// Stamps "a human is here" so the keeper can drop its price pushes and market
// creation to an idle cadence while nobody is around (see lib/activity.ts,
// keeper/onchainPriceRecorder.ts and keeper/idleMatrix.ts).
const PRESENCE_IGNORED_EXACT = new Set([
  '/api/keeper/health',
  '/api/geo',
  '/api/geo/config',
])

/**
 * Whether a request should count as a human being on the site.
 *
 * Everything under /health is monitoring, by prefix rather than by listing the
 * paths. The list form was correct until someone added a probe to it, and on
 * 2026-08-30 someone did: /health/edge went in as a watchdog target and not
 * into the ignore list, so a check every two minutes told the backend a user
 * was present around the clock. The keeper never dropped to its idle cadence
 * and spent the night creating 41 to 69 markets an hour at zero users - market
 * creation being the single largest cost this project has. The indexer's watch
 * list grew to 1402 addresses, eth_getLogs began being rejected for size, and
 * the keeper logged 4,500 RPC errors an hour into a log that rotates every few
 * hours, taking the diagnostic history with it.
 *
 * A prefix cannot be forgotten by the next probe.
 */
export function marksPresence(path: string): boolean {
  if (path === '/health' || path.startsWith('/health/')) return false
  return !PRESENCE_IGNORED_EXACT.has(path)
}

/**
 * Paths served to callers that did not come through the Cloudflare Worker.
 *
 * Only the two probes an external monitor has to be able to reach. Both are
 * already geo-exempt at the edge and deliberately world-readable - a fixed
 * machine word, no balances, no addresses, no user or market data - so serving
 * them from the bare origin discloses nothing the block exists to withhold.
 * Requiring the edge here would blind the only outside check that production
 * is alive.
 */
export const EDGE_EXEMPT_PATHS = new Set([
  '/health',
  '/health/deep',
])

export interface HttpPluginOpts {
  corsOrigins:   string[]
  workerSecret?: string
  rateLimitMax?: number
  markActivity:  () => Promise<void>
}

export async function registerHttpPlugins(app: FastifyInstance, opts: HttpPluginOpts) {
  await app.register(cors, { origin: opts.corsOrigins })

  // keyGenerator, not the default req.ip - see lib/clientKey.ts. Without it the
  // whole API shares a single budget, because behind Caddy every request
  // presents the same peer address.
  await app.register(rateLimit, {
    max:          opts.rateLimitMax ?? 100,
    timeWindow:   '1 minute',
    keyGenerator: makeClientKey(opts.workerSecret),
  })

  // ── PROOF OF EDGE ────────────────────────────────────────
  // The country block lives in the Cloudflare Worker, and the Worker refuses
  // blocked countries before it forwards anything. That is only a control if
  // the origin cannot be addressed around it - and it can: the IP resolves and
  // Caddy answers for the hostname, which is how the full API, including the
  // signed payload needed to place a bet, was reachable from a blocked country
  // by anyone who found it.
  //
  // The origin deliberately does not re-implement the country list. A request
  // carrying the shared secret has already passed the edge's check by
  // construction; a request without it did not come through the edge at all,
  // and that is the only question the origin has to answer.
  if (opts.workerSecret) {
    const secret = opts.workerSecret
    app.addHook('onRequest', async (req, reply) => {
      if (req.method === 'OPTIONS') return
      if (EDGE_EXEMPT_PATHS.has(req.url.split('?')[0])) return
      if (req.headers['x-worker-secret'] !== secret) {
        return reply.code(403).send({ error: 'direct_origin_access' })
      }
    })
  } else {
    // Local development, where there is no Worker in front. Loud because the
    // same condition in production would silently remove the geo control.
    app.log.warn(
      'WORKER_SECRET is not set: serving the API without proof-of-edge. ' +
      'In production this disables geo-blocking entirely.',
    )
  }

  app.addHook('onRequest', async (req) => {
    if (req.method === 'OPTIONS') return
    if (!marksPresence(req.url.split('?')[0])) return
    await opts.markActivity()
  })
}
