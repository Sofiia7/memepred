/**
 * MemePred edge router.
 *
 * Cloudflare Worker that sits in front of the public API.
 *  - Reads `request.cf.country` (set by Cloudflare).
 *  - Blocks requests from BLOCKED regions with HTTP 451.
 *  - Forwards everything else to ORIGIN, attaching:
 *      x-country         : the resolved country code (or "XX")
 *      x-worker-secret   : shared secret so the origin can trust x-country
 *
 * Required Worker secrets / env vars:
 *   ORIGIN_URL       e.g. "https://api.memepred.xyz"
 *   WORKER_SECRET    matches backend WORKER_SECRET (used by /api/geo)
 *
 * Deploy: wrangler deploy. Route the Worker to /* on api.memepred.xyz so the
 * direct origin host (e.g. api-origin.memepred.xyz) stays internal.
 */

export interface Env {
  ORIGIN_URL: string
  WORKER_SECRET: string
}

const BLOCKED = new Set([
  'US', 'GB', 'FR', 'DE', 'NL', 'CA', 'AU', 'JP', 'SG'
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
          message: 'MemePred is not available in your region.',
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

    if (!env.ORIGIN_URL || !env.WORKER_SECRET) {
      return new Response(
        JSON.stringify({ error: 'worker_misconfigured' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      )
    }

    // Rewrite to origin while preserving path/query/body.
    const outUrl = new URL(env.ORIGIN_URL)
    outUrl.pathname = inUrl.pathname
    outUrl.search   = inUrl.search

    const headers = new Headers(request.headers)
    headers.set('x-country',       country)
    headers.set('x-worker-secret', env.WORKER_SECRET)
    // Strip any caller-supplied secret to prevent spoofing.
    headers.delete('cf-connecting-ip') // origin should not trust it here

    const upstream = new Request(outUrl.toString(), {
      method:   request.method,
      headers,
      body:     request.body,
      redirect: 'manual'
    })

    return fetch(upstream)
  }
}
