/**
 * FlipTheMeme edge router.
 *
 * Cloudflare Worker that sits in front of the public API.
 *  - Reads `request.cf.country` (set by Cloudflare).
 *  - Blocks requests from BLOCKED regions with HTTP 451.
 *  - Forwards everything else to the origin, attaching:
 *      x-country         : the resolved country code (or "XX")
 *      x-worker-secret   : shared secret so the origin can trust x-country
 *
 * 2026-07-07: simplified away from the original "separate ORIGIN_URL /
 * api-origin hostname" design. Cloudflare's documented behavior is that a
 * same-zone fetch() subrequest from within a Worker always goes straight to
 * the zone's configured origin server — it does NOT re-invoke the Worker
 * (this is the documented loop-prevention rule, not an assumption). So the
 * pass-through fetch below reuses the incoming request's own URL
 * (api.flipthememe.com) instead of needing a second DNS-only hostname —
 * one less moving part, and Caddy's existing cert already covers it.
 *
 * Required Worker secret:
 *   WORKER_SECRET    matches backend's WORKER_SECRET (used by /api/geo)
 *
 * Deploy: wrangler deploy (route is configured in wrangler.toml).
 */

export interface Env {
  WORKER_SECRET: string
}

// 2026-07-07: broader jurisdiction block (US/UK/EU/etc) paused per product
// decision — the wider list is a business/regulatory-risk call, not a legal
// requirement, and can be re-added later without touching this file's shape.
//
// This shortlist stays on regardless: OFAC's comprehensively-sanctioned
// countries (Cuba, Iran, North Korea, Syria). Unlike the paused list, this
// one is U.S. federal sanctions law (strict liability — applies no matter
// where the operator is incorporated, and doesn't scale with traffic volume
// or revenue the way "regulatory risk" does). Do not remove without legal
// sign-off. Russia is deliberately NOT included here — Russia sanctions are
// sectoral/program-based, not a blanket embargo like the four below: adding
// it would be a separate business decision, not an OFAC minimum.
const BLOCKED = new Set([
  'CU', 'IR', 'KP', 'SY'
])

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const country = ((request as any).cf?.country as string | undefined) || 'XX'

    const inUrl = new URL(request.url)
    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    if (BLOCKED.has(country)) {
      return new Response(
        JSON.stringify({
          error:   'region_blocked',
          message: 'FlipTheMeme is not available in your region.',
          country
        }),
        {
          status:  451,
          headers: {
            'Content-Type':  'application/json',
            'Cache-Control': 'no-store',
            ...corsHeaders
          }
        }
      )
    }

    // Short-circuit /api/geo at the edge so the frontend doesn't need a
    // backend just to learn its own country code.
    if (inUrl.pathname === '/api/geo') {
      return new Response(
        JSON.stringify({ country }),
        {
          status:  200,
          headers: {
            'Content-Type':  'application/json',
            'Cache-Control': 'no-store',
            ...corsHeaders
          }
        }
      )
    }

    // Sprint 4.8: single source of truth for the blocked-country list.
    // Frontend fetches this to render the geoblock UI consistently with
    // what the edge actually enforces.
    if (inUrl.pathname === '/api/geo/config') {
      return new Response(
        JSON.stringify({ blocked: Array.from(BLOCKED) }),
        {
          status:  200,
          headers: {
            'Content-Type':  'application/json',
            // 10-min edge cache; clients also force-cache.
            'Cache-Control': 'public, max-age=600',
            ...corsHeaders
          }
        }
      )
    }

    if (!env.WORKER_SECRET) {
      return new Response(
        JSON.stringify({ error: 'worker_misconfigured' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      )
    }

    const headers = new Headers(request.headers)
    headers.set('x-country',       country)
    headers.set('x-worker-secret', env.WORKER_SECRET)
    // Strip any caller-supplied secret to prevent spoofing.
    headers.delete('cf-connecting-ip') // origin should not trust it here

    // Same-hostname request — Cloudflare sends same-zone Worker subrequests
    // straight to the configured origin, never back into this Worker.
    const upstream = new Request(request.url, {
      method:   request.method,
      headers,
      body:     request.body,
      redirect: 'manual'
    })

    return fetch(upstream)
  }
}
