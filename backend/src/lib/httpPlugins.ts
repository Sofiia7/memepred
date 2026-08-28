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
// Stamps "a human is here" so the keeper can drop its on-chain price push from
// every 30s to a slow heartbeat while nobody is around (see lib/activity.ts
// and keeper/onchainPriceRecorder.ts).
//
// Health and monitoring endpoints are excluded deliberately: an uptime checker
// polling every two minutes would otherwise keep the product permanently
// "busy" and quietly undo the entire saving.
export const PRESENCE_IGNORED = new Set([
  '/health',
  '/health/deep',
  '/api/keeper/health',
  '/api/geo',
  '/api/geo/config',
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

  app.addHook('onRequest', async (req) => {
    if (req.method === 'OPTIONS') return
    if (PRESENCE_IGNORED.has(req.url.split('?')[0])) return
    await opts.markActivity()
  })
}
