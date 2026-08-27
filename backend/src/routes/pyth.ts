/**
 * Server-side proxy to Pyth Hermes.
 *
 * Since 2026-08-26 Hermes requires a bearer token, and the browser cannot hold
 * one: Vite bakes VITE_* variables into the public bundle, so shipping the key
 * to the frontend would publish it. usePlaceBet (which needs a fresh signed
 * price to submit with every bet) and usePythPrice (live display) therefore
 * come through here instead of calling hermes.pyth.network directly.
 *
 * Two things this must not become: an open proxy that lets anyone pull any feed
 * on our quota, and a per-visitor multiplier on a metered upstream.
 */
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hermesFetch, HermesAuthError } from '../lib/hermes.js'

export interface PythRouteOptions {
  apiKey:       string | undefined
  hermesUrl:    string
  allowedFeeds: Set<string>
}

/**
 * How long an upstream response is reused. The two callers want opposite
 * things, so they get different answers.
 *
 * A bet is signed against the payload this returns and then has to survive the
 * user confirming in their wallet, all inside the contract's MAX_PRICE_AGE of
 * 60s. Short.
 *
 * A displayed price is the entire load: usePythPrice refetches every 10s on
 * every open page, and this cache is what stops that scaling with the number of
 * visitors - but only up to its own TTL. At 2s across two feeds this endpoint
 * alone would make 20 upstream calls per 10s and Pyth's public tier allows 10.
 * There is also nothing to gain from being fresher than the only consumer, so
 * it matches the frontend's own poll interval.
 */
const BET_TTL_MS     = 2_000
const DISPLAY_TTL_MS = 10_000

const Query = z.object({
  ids:    z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'invalid feed id'),
  parsed: z.enum(['true', 'false']).default('false'),
})

interface CacheEntry { at: number; status: number; body: string; contentType: string }

export async function pythRoutes(app: FastifyInstance, opts: PythRouteOptions) {
  const { apiKey, hermesUrl, allowedFeeds } = opts

  // Lowercased once so a caller's hex casing cannot miss the whitelist.
  const allowed = new Set([...allowedFeeds].map((f) => f.toLowerCase()))
  const cache = new Map<string, CacheEntry>()

  app.get('/updates', async (req, reply) => {
    const parsedQuery = Query.safeParse(req.query)
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: parsedQuery.error.issues[0]?.message ?? 'bad request' })
    }

    const { ids, parsed } = parsedQuery.data
    const feedId = ids.toLowerCase()

    // Whitelist, not just format: otherwise this is an authenticated pipe to
    // every feed Pyth publishes, billed to us.
    if (!allowed.has(feedId)) {
      return reply.code(400).send({ error: 'feed not supported' })
    }

    const cacheKey = `${feedId}:${parsed}`
    const ttl      = parsed === 'true' ? DISPLAY_TTL_MS : BET_TTL_MS
    const hit = cache.get(cacheKey)
    if (hit && Date.now() - hit.at < ttl) {
      return reply.code(hit.status).header('content-type', hit.contentType).send(hit.body)
    }

    // encoding is fixed rather than forwarded: the callers all want hex, and a
    // caller-controlled value would be one more thing reaching upstream
    // unvalidated for no benefit.
    const url =
      `${hermesUrl}/v2/updates/price/latest?ids[]=${feedId}&encoding=hex&parsed=${parsed}`

    try {
      const res  = await hermesFetch(url, apiKey)
      const text = await res.text()
      const contentType = res.headers.get('content-type') ?? 'application/json'

      // Only successes are cached. A cached failure would turn one bad minute
      // upstream into a stuck endpoint.
      cache.set(cacheKey, { at: Date.now(), status: 200, body: text, contentType })

      return reply.code(200).header('content-type', contentType).send(text)
    } catch (err) {
      // 502 in both branches: whatever went wrong, it is our side of the wire.
      // Passing a 401 through would tell the browser it is unauthenticated,
      // which is neither true nor something the user can act on.
      if (err instanceof HermesAuthError) {
        req.log.error({ err }, 'Hermes credentials rejected - check PYTH_API_KEY')
        return reply.code(502).send({ error: 'price feed unavailable' })
      }
      req.log.error({ err }, 'Hermes request failed')
      return reply.code(502).send({ error: 'price feed unavailable' })
    }
  })
}
