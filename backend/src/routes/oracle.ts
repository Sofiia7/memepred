/**
 * Oracle data for the frontend.
 *
 * Unlike the Pyth proxy this replaces, there is no secret being hidden here:
 * RedStone's gateway needs no credential. Two other reasons keep it:
 *
 *   - the browser would otherwise have to build payloads itself, which means
 *     bundling @redstone-finance/protocol and its ethers v5 dependency into a
 *     viem app for the sake of one concatenation;
 *   - one cache in front of the gateway keeps our request rate flat instead of
 *     scaling with however many people have the page open.
 */
import { FastifyInstance } from 'fastify'
import { z } from 'zod'

export interface OracleRouteOptions {
  allowedFeeds: Set<string>
  fetchPayload: (symbol: string) => Promise<string>
  fetchPrice:   (symbol: string) => Promise<number>
}

/**
 * A payload is signed at fetch time and OrderbookMarket rejects one older than
 * ENTRY_MAX_PRICE_AGE (20s). The user still has to read the confirmation and
 * sign after we serve it, so most of that window has to be left unspent.
 */
const PAYLOAD_TTL_MS = 3_000

/**
 * A displayed price is refetched by the frontend on a 10s timer, and there is
 * nothing to gain from being fresher than the only consumer.
 */
const PRICE_TTL_MS = 10_000

const Query = z.object({ feed: z.string().min(1).max(32) })

interface Entry<T> { at: number; value: T }

export async function oracleRoutes(app: FastifyInstance, opts: OracleRouteOptions) {
  const { allowedFeeds, fetchPayload, fetchPrice } = opts

  const payloadCache = new Map<string, Entry<string>>()
  const priceCache   = new Map<string, Entry<number>>()

  /** Validates the feed, or answers 400 and returns null. */
  function feedOf(req: { query: unknown }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    const parsed = Query.safeParse(req.query)
    if (!parsed.success) {
      reply.code(400).send({ error: 'feed required' })
      return null
    }
    // Whitelist, not just shape: otherwise this is an open proxy to every feed
    // RedStone publishes, running on our budget.
    if (!allowedFeeds.has(parsed.data.feed)) {
      reply.code(400).send({ error: 'feed not supported' })
      return null
    }
    return parsed.data.feed
  }

  async function cached<T>(
    cache: Map<string, Entry<T>>,
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
  ): Promise<T> {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ttlMs) return hit.value

    const value = await load()
    // Only successes are cached: a cached failure would turn one bad minute
    // upstream into a stuck endpoint.
    cache.set(key, { at: Date.now(), value })
    return value
  }

  app.get('/payload', async (req, reply) => {
    const feed = feedOf(req, reply)
    if (!feed) return

    try {
      const payload = await cached(payloadCache, feed, PAYLOAD_TTL_MS, () => fetchPayload(feed))
      return reply.code(200).send({ feed, payload })
    } catch (err) {
      // 502 either way: whatever went wrong is on our side of the wire, and
      // there is nothing the browser can do differently.
      req.log.error({ err }, `RedStone payload unavailable for ${feed}`)
      return reply.code(502).send({ error: 'price feed unavailable' })
    }
  })

  app.get('/price', async (req, reply) => {
    const feed = feedOf(req, reply)
    if (!feed) return

    try {
      const price = await cached(priceCache, feed, PRICE_TTL_MS, () => fetchPrice(feed))
      return reply.code(200).send({ feed, price })
    } catch (err) {
      req.log.error({ err }, `RedStone price unavailable for ${feed}`)
      return reply.code(502).send({ error: 'price feed unavailable' })
    }
  })
}
