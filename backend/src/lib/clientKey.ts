/**
 * Per-client identity for rate limiting.
 *
 * The API sits behind Cloudflare -> Caddy -> Fastify. Fastify is created
 * without `trustProxy`, so `req.ip` is the TCP peer, which is always the Caddy
 * container — one address for every human on earth. @fastify/rate-limit keys on
 * `req.ip` by default, so the 100-requests-per-minute budget was global: any
 * one person could lock the whole API for everyone with a phone, and a handful
 * of simultaneous visitors would have throttled each other on launch day.
 * Verified in production on 2026-08-09 by bursting through Cloudflare and then
 * hitting the origin IP directly — a completely different network path — and
 * getting 429 from the same bucket.
 *
 * `trustProxy: true` is not the fix. Caddy sets X-Forwarded-For to its own TCP
 * peer, which for proxied traffic is a Cloudflare edge address, so the bucket
 * would still be shared across everyone behind that edge node. The real client
 * address only exists in CF-Connecting-IP.
 *
 * That header is trusted ONLY on requests carrying the Worker's shared secret.
 * The origin is reachable directly (its IP resolves and Caddy answers for the
 * hostname), so without that gate an attacker could send a random
 * CF-Connecting-IP per request and skip rate limiting entirely.
 */
export function makeClientKey(workerSecret: string | undefined) {
  const secret = workerSecret && workerSecret.length > 0 ? workerSecret : undefined

  return function clientKey(req: {
    ip: string
    headers: Record<string, string | string[] | undefined>
  }): string {
    if (secret) {
      const presented = req.headers['x-worker-secret']
      if (typeof presented === 'string' && presented === secret) {
        const cf = req.headers['cf-connecting-ip']
        if (typeof cf === 'string' && cf.length > 0) return cf
      }
    }
    return req.ip
  }
}
