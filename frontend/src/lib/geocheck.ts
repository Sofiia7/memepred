/**
 * geocheck - Sprint 4.6 + 4.8, three-state result added 2026-09-29.
 *
 * Behaviour change vs. v1:
 *   - 451 from edge -> blocked (unchanged)
 *   - Any other failure (5xx, network failure, DNS fail, timeout, an answer
 *     we cannot read) -> UNVERIFIED unless VITE_DISABLE_GEOBLOCK=1. v1 was
 *     fail-open, which let users in when the backend / worker was
 *     misconfigured. For a regulated product that's unacceptable, so trading
 *     stays fail-closed: "unverified" shows no app content at all.
 *   - But "we could not ask" is not "your country is banned". Those used to
 *     collapse into one REGION BLOCKED screen, so an unreachable API told a
 *     visitor in a permitted country that theirs was prohibited. They are two
 *     different results now, with different screens and a Retry on the second.
 *   - The check has a deadline. There used to be none, so a hung request left
 *     the page blank forever.
 *   - Country list lives on the Worker (`/api/geo/config`). Frontend
 *     compares country against that authoritative list - no local
 *     duplication that can drift.
 */

export type GeoStatus = 'allowed' | 'blocked' | 'unverified'

export interface GeoResult {
  status: GeoStatus
  /** ISO code when the API told us, otherwise 'XX'. */
  country: string
}

/** How long either request may take before the check gives up (unverified). */
export const GEO_TIMEOUT_MS = 8_000

// Mirrors workers/geo-block.ts's BLOCKED set - kept in sync manually since
// this is only the fallback used if /api/geo/config is unreachable.
//
// Note this list is nearly unreachable in practice: the Worker evaluates
// BLOCKED *before* it serves /api/geo, so a user in a blocked country gets
// 451 there and checkGeo() returns early without ever consulting this. It
// still gets kept in sync so the two files never disagree on the record.
const FALLBACK_BLOCKED = [
  // OFAC comprehensively-sanctioned
  'CU', 'IR', 'KP', 'SY',
  // Restricted jurisdictions (see workers/geo-block.ts for the reasoning)
  'US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM',
  'GB', 'FR', 'DE', 'NL', 'CA', 'AU', 'JP', 'SG',
  'T1',
]

let cachedBlocked: string[] | null = null

interface Fetched {
  status: number
  ok: boolean
  /** null when the body was empty, not JSON, or the deadline hit while reading it. */
  json: unknown
}

/**
 * One request under a deadline that covers the body as well as the headers: a
 * server that answers 200 and then stalls must not hang the page either.
 * Rejects on a network failure or when the deadline passes before any answer.
 */
async function fetchJson(url: string, init?: RequestInit): Promise<Fetched> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      json = null
    }
    return { status: res.status, ok: res.ok, json }
  } finally {
    clearTimeout(timer)
  }
}

function normalizeCountry(v: unknown): string {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim().toUpperCase() : 'XX'
}

async function fetchBlockedList(): Promise<string[]> {
  if (cachedBlocked) return cachedBlocked
  try {
    const r = await fetchJson(`${import.meta.env.VITE_API_URL}/api/geo/config`, {
      // Cache the list at the edge; clients refresh on reload.
      cache: 'force-cache',
    })
    const j = r.json as { blocked?: unknown } | null
    if (r.ok && j && Array.isArray(j.blocked)) {
      // An empty or all-garbage list is never trusted: it would block nobody.
      const list = j.blocked.filter((c): c is string => typeof c === 'string').map((c) => c.toUpperCase())
      if (list.length > 0) {
        cachedBlocked = list
        return list
      }
    }
  } catch {
    // fall through
  }
  // Not cached: an unreachable config endpoint is worth asking again on the
  // next check, and the fallback is exactly as strict as the Worker's list.
  return FALLBACK_BLOCKED
}

export async function checkGeo(): Promise<GeoResult> {
  // Explicit kill-switch for previews / dev where there is no backend / Worker.
  if (import.meta.env.VITE_DISABLE_GEOBLOCK === '1') {
    return { status: 'allowed', country: 'XX' }
  }

  let country = 'XX'
  try {
    const r = await fetchJson(`${import.meta.env.VITE_API_URL}/api/geo`)
    // 451 = explicit edge block - done. The Worker puts the country in the body.
    if (r.status === 451) {
      const body = r.json as { country?: unknown } | null
      return { status: 'blocked', country: normalizeCountry(body?.country) }
    }
    // Fail-closed: any other non-ok means we can't trust the answer.
    if (!r.ok) return { status: 'unverified', country: 'XX' }
    const body = r.json as { country?: unknown } | null
    // A 200 whose body we cannot read tells us nothing about the country.
    if (!body || typeof body !== 'object') return { status: 'unverified', country: 'XX' }
    country = normalizeCountry(body.country)
  } catch {
    // Network or worker totally unreachable, or the deadline passed.
    return { status: 'unverified', country: 'XX' }
  }

  const blockedList = await fetchBlockedList()
  return {
    status: blockedList.includes(country) ? 'blocked' : 'allowed',
    country,
  }
}
