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
 * the zone's configured origin server - it does NOT re-invoke the Worker
 * (this is the documented loop-prevention rule, not an assumption). So the
 * pass-through fetch below reuses the incoming request's own URL
 * (api.flipthememe.com) instead of needing a second DNS-only hostname - 
 * one less moving part, and Caddy's existing cert already covers it.
 *
 * Required Worker secret:
 *   WORKER_SECRET    matches backend's WORKER_SECRET (used by /api/geo)
 *
 * Optional Worker variable (wrangler.toml [vars], not a secret):
 *   GEO_OPEN_COUNTRIES   ISO codes opened for THIS deployment only (see Env)
 *
 * Deploy: wrangler deploy (route is configured in wrangler.toml).
 */

export interface Env {
  WORKER_SECRET: string
  /**
   * Optional, per deployment: comma-separated ISO codes to take OFF the
   * restricted-jurisdictions list for this Worker only, e.g. "SG". Unset (the
   * Base worker) means the full list below. It can open only the countries in
   * OPENABLE_JURISDICTIONS: an OFAC country, the U.S. and its territories,
   * Tor and any junk value are ignored, so a typo in a toml file can never
   * widen the sanctions or CFTC exposure or switch the whole list off.
   */
  GEO_OPEN_COUNTRIES?: string
}

// ── LAYER 1: OFAC comprehensively-sanctioned countries ─────────────────
// U.S. federal sanctions law, strict liability - applies no matter where the
// operator is incorporated, and doesn't scale with traffic volume or revenue
// the way "regulatory risk" does. Do not remove without legal sign-off.
// Russia is deliberately NOT included: Russia sanctions are sectoral/
// program-based, not a blanket embargo like the four below - adding it would
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
//      written representation contradicted by our own public code - the
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
// geoblock copy in sync - /api/geo/config below is what the frontend reads,
// so the UI follows this constant automatically.
const RESTRICTED_JURISDICTIONS = [
  // United States + territories under the same federal regulators. The
  // territories are the part that usually gets missed: Cloudflare reports
  // them as their own ISO codes, not as 'US'.
  'US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM',
  // Gambling/derivatives regulators with a track record of acting against
  // offshore prediction markets.
  'GB', // United Kingdom (Gambling Commission) - note: 'GB', not 'UK'
  'FR', 'DE', 'NL', 'CA', 'AU', 'JP', 'SG',
  // Cloudflare's pseudo-country for Tor exit nodes. Included so the block
  // can't be sidestepped with one browser download - the point of this list
  // is a good-faith exclusion, and a trivially bypassable one argues against
  // us. Remove if Tor traffic turns out to be legitimate users.
  'T1'
]

/**
 * The only restricted jurisdictions a deployment may open through
 * GEO_OPEN_COUNTRIES. The U.S. and its territories are deliberately not here
 * (see the CFTC note above: not serving them is the one thing that cures that
 * exposure) and neither is Tor ('T1'), which would sidestep every other line.
 * Adding a country here is a code change and a decision, not a typo away.
 */
const OPENABLE_JURISDICTIONS = new Set(['GB', 'FR', 'DE', 'NL', 'CA', 'AU', 'JP', 'SG'])

/**
 * The blocked set for one deployment: every OFAC country, plus every restricted
 * jurisdiction that this deployment has not explicitly opened through
 * GEO_OPEN_COUNTRIES. Exported so the tests (and the frontend's parity test)
 * can pin exactly what each deployment enforces.
 */
export function blockedFor(env: Pick<Env, 'GEO_OPEN_COUNTRIES'>): Set<string> {
  const open = new Set(
    (env.GEO_OPEN_COUNTRIES ?? '')
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter((c) => OPENABLE_JURISDICTIONS.has(c))
  )
  return new Set([
    ...OFAC_SANCTIONED,
    ...RESTRICTED_JURISDICTIONS.filter((c) => !open.has(c))
  ])
}

// ── GEO-EXEMPT PATHS ───────────────────────────────────────────────────
// 2026-07-25: turning on the US block immediately took the uptime monitor
// down - UptimeRobot checks from Ohio and got a correct, working 451, which
// its dashboard reports as an outage. The block was doing its job; the
// monitor was the casualty.
//
// What the jurisdiction block exists to prevent is *offering the product* to
// people in these places: seeing markets, placing bets, moving funds. A
// liveness probe is none of that. `/health` returns `{status, ts}` - no
// market data, no user data, no action, nothing that could be construed as
// solicitation. Blocking it buys zero legal protection and costs all of our
// monitoring, so it is exempt.
//
// Deliberately NOT short-circuited at the edge: the request still goes
// through to the origin, so a dead backend still reads as down. An edge-level
// 200 would make the monitor permanently green and worse than useless.
//
// Keep this list minimal and strictly non-product. If a path returns market
// data, user data, or accepts any action, it does not belong here.
const GEO_EXEMPT_PATHS = new Set([
  '/health',
  // The probe that can actually go red. `/health` answers 200 for as long as
  // the Fastify process has a pulse, so a monitor watching it stayed green
  // through a 15-day keeper stall. `/health/deep` returns `{status, reason}`
  // with a fixed machine word for `reason` and nothing else - no balances, no
  // addresses, no market or user data - so exempting it discloses nothing the
  // block exists to withhold. See backend/src/routes/keeperHealth.ts.
  '/health/deep',
  // Proof that this Worker and the origin still agree on WORKER_SECRET. Exempt
  // from the country block so a monitor can reach it from anywhere - it is
  // forwarded like any other path, so it still gets the secret attached, and
  // the origin answers 200 only if that secret is the one it expects. It
  // carries a status word and nothing else.
  '/health/edge',
])

// Certificate authorities prove control of a hostname by fetching
// /.well-known/acme-challenge/<token> over plain HTTP, and their validators sit
// in the U.S. and other blocked countries. 2026-09-29: the RHC API could not get
// its certificate because every challenge came back 451 from this very Worker
// (Caddy's log: "Invalid response ... 451"), and the Base API's certificate,
// which expires on 2026-10-05, was queued for a renewal that would have hit the
// same wall. The path carries a one-time token and nothing else - no market
// data, no user data, no action - so exempting it discloses nothing the block
// exists to withhold. Like the paths above it is still forwarded to the origin,
// which answers only a challenge it has issued.
const ACME_CHALLENGE_PREFIX = '/.well-known/acme-challenge/'

/** Whether a path may be reached from a blocked country. Exported for the tests. */
export function isGeoExempt(pathname: string): boolean {
  return GEO_EXEMPT_PATHS.has(pathname) || pathname.startsWith(ACME_CHALLENGE_PREFIX)
}

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

    const BLOCKED = blockedFor(env)
    if (BLOCKED.has(country) && !isGeoExempt(inUrl.pathname)) {
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

    // Same-hostname request - Cloudflare sends same-zone Worker subrequests
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
