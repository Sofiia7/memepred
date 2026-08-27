/**
 * Authenticated access to Pyth Hermes.
 *
 * Pyth closed the public Hermes endpoint on 2026-08-26 at 16:00 UTC as part of
 * the Pyth Core upgrade. `hermes.pyth.network` now answers 401 "unauthorized"
 * to every unauthenticated caller, which took production down: the keeper's
 * price pushes, market rollovers and settlements all failed in a loop while the
 * process stayed up and the watchdog kept ticking.
 *
 * The key is a bearer token issued from Pyth Terminal. It is a server-side
 * secret and must never reach the browser bundle, which is why the frontend
 * goes through routes/pyth.ts instead of calling Hermes directly.
 */

/** A Hermes call that failed because of credentials, not because of the network. */
export class HermesAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HermesAuthError'
  }
}

/**
 * Request headers for a Hermes call.
 *
 * Throws rather than returning empty headers when no key is configured. An
 * unauthenticated request is guaranteed to 401, and the whole point is to fail
 * where the cause is visible instead of turning into an anonymous fetch error
 * inside somebody's retry loop.
 */
export function hermesHeaders(apiKey: string | undefined): Record<string, string> {
  if (!apiKey) {
    throw new HermesAuthError(
      'PYTH_API_KEY is not set. Hermes has required a bearer token since ' +
      '2026-08-26; register at Pyth Terminal and set PYTH_API_KEY.',
    )
  }
  return { Authorization: `Bearer ${apiKey}` }
}

/**
 * GET from Hermes with the bearer token attached.
 *
 * A 401 comes back as HermesAuthError so callers can tell "our key is wrong"
 * from "Hermes is having a moment" - the first is a page-someone problem, the
 * second is worth retrying. Any other non-2xx keeps its status in the message,
 * which is what the existing callers already log.
 */
export async function hermesFetch(
  url: string,
  apiKey: string | undefined,
  timeoutMs = 8_000,
): Promise<Response> {
  const headers = hermesHeaders(apiKey)
  // A connection that is accepted and then never answered would otherwise hang
  // the caller indefinitely. The watchdog pings every feed in sequence on a
  // timer, so one hung request stalls the balance checks and the health
  // snapshot behind it.
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })

  if (res.status === 401 || res.status === 403) {
    throw new HermesAuthError(
      `Hermes rejected our credentials (${res.status}). Check PYTH_API_KEY.`,
    )
  }
  if (!res.ok) throw new Error(`hermes ${res.status}`)

  return res
}
