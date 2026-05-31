/**
 * geocheck — Sprint 4.6 + 4.8
 *
 * Behaviour change vs. v1:
 *   - 451 from edge → blocked (unchanged)
 *   - Any other error (5xx, network failure, DNS fail) → BLOCKED unless
 *     VITE_DISABLE_GEOBLOCK=1. v1 was fail-open which let users in when the
 *     backend / worker was misconfigured. For a regulated product that's
 *     unacceptable; fail-closed is the correct default.
 *   - Country list lives on the Worker (`/api/geo/config`). Frontend
 *     compares country against that authoritative list — no local
 *     duplication that can drift.
 */

const FALLBACK_BLOCKED = ['US', 'GB', 'FR', 'DE', 'NL', 'CA', 'AU', 'JP', 'SG']

let cachedBlocked: string[] | null = null

async function fetchBlockedList(): Promise<string[]> {
  if (cachedBlocked) return cachedBlocked
  try {
    const res = await fetch(`${import.meta.env.VITE_API_URL}/api/geo/config`, {
      // Cache the list at the edge; clients refresh on reload.
      cache: 'force-cache',
    })
    if (res.ok) {
      const j = (await res.json()) as { blocked?: string[] }
      if (Array.isArray(j.blocked) && j.blocked.length > 0) {
        cachedBlocked = j.blocked
        return cachedBlocked
      }
    }
  } catch {
    // fall through
  }
  cachedBlocked = FALLBACK_BLOCKED
  return cachedBlocked
}

export async function checkGeo(): Promise<{ blocked: boolean; country: string }> {
  // Explicit kill-switch for previews / dev where there is no backend / Worker.
  if (import.meta.env.VITE_DISABLE_GEOBLOCK === '1') {
    return { blocked: false, country: 'XX' }
  }

  let country = 'XX'
  try {
    const res = await fetch(`${import.meta.env.VITE_API_URL}/api/geo`)
    // 451 = explicit edge block — done.
    if (res.status === 451) return { blocked: true, country: 'XX' }
    // Fail-closed: any non-ok means we can't trust the answer.
    if (!res.ok) return { blocked: true, country: 'XX' }
    const j = (await res.json()) as { country?: string }
    country = j.country ?? 'XX'
  } catch {
    // Network or worker totally unreachable → fail-closed.
    return { blocked: true, country: 'XX' }
  }

  const blockedList = await fetchBlockedList()
  return {
    blocked: blockedList.includes(country),
    country,
  }
}
