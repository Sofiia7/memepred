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

// ── LAYER 1: OFAC comprehensively-sanctioned countries ─────────────────
// U.S. federal sanctions law, strict liability — applies no matter where the
// operator is incorporated, and doesn't scale with traffic volume or revenue
// the way "regulatory risk" does. Do not remove without legal sign-off.
// Russia is deliberately NOT included: Russia sanctions are sectoral/
// program-based, not a blanket embargo like the four below — adding it would
// be a separate business decision, not an OFAC minimum.
const OFAC_SANCTIONED = [
  'CU', 'IR', 'KP', 'SY'
]

// ── LAYER 2: restricted jurisdictions (regulatory-risk decision) ───────
// 2026-07-25: re-enabled after being paused on 2026-07-07. Two reasons the
// pause stopped being defensible:
//
//   1. docs/legal/tos-privacy-draft.md §3 already states these exact
//      territories are restricted AND cites this file as the enforcement
//      point. Publishing that text while this list was down would be a
//      written representation contradicted by our own public code — the
//      thing that turns "we didn't know" into "they knew and said
//      otherwise". Either the list or the ToS had to move; the list moved.
//
//   2. The U.S. specifically is not just one more line item. Short-horizon
//      UP/DOWN price contracts are event-based binary options under the CEA;
//      offering them off-exchange to U.S. persons is what produced
//      Polymarket's Jan-2022 CFTC settlement ($1.4M + forced wind-down) and
//      the subsequent DOJ interest in its founder personally. Incorporating
//      elsewhere does not cure it; not serving U.S. persons does.
//
// Keep this list, docs/legal/tos-privacy-draft.md §3, and the frontend's
// geoblock copy in sync — /api/geo/config below is what the frontend reads,
// so the UI follows this constant automatically.
const RESTRICTED_JURISDICTIONS = [
  // United States + territories under the same federal regulators. The
  // territories are the part that usually gets missed: Cloudflare reports
  // them as their own ISO codes, not as 'US'.
  'US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM',
  // Gambling/derivatives regulators with a track record of acting against
  // offshore prediction markets.
  'GB', // United Kingdom (Gambling Commission) — note: 'GB', not 'UK'
  'FR', 'DE', 'NL', 'CA', 'AU', 'JP', 'SG',
  // Cloudflare's pseudo-country for Tor exit nodes. Included so the block
  // can't be sidestepped with one browser download — the point of this list
  // is a good-faith exclusion, and a trivially bypassable one argues against
  // us. Remove if Tor traffic turns out to be legitimate users.
  'T1'
]

const BLOCKED = new Set([...OFAC_SANCTIONED, ...RESTRICTED_JURISDICTIONS])

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
