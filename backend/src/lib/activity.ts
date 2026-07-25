/**
 * activity — shared "is anyone actually here?" signal.
 *
 * Sprint 5.6. The keeper pushes Pyth prices on-chain every 30s so that
 * OrderbookMarket.ENTRY_MAX_PRICE_AGE (45s) is satisfied whenever someone
 * calls the bare `placeBet`. That cadence is 5,760 transactions a day per
 * two feeds, and it ran identically whether the product had a thousand users
 * or none — the largest running cost that scaled with nothing.
 *
 * This lets the keeper tell the difference. The API stamps a Redis key on
 * real user traffic; the keeper reads it and keeps the fast cadence only
 * while somebody is around, falling back to a slow heartbeat otherwise.
 *
 * Why a cold arrival is still safe:
 *   - Loading the app hits the API, which stamps activity here, so the
 *     keeper is back on the 30s cadence within one tick — well before a
 *     visitor has picked a market and signed anything.
 *   - Independently, the frontend's preferred path is `placeBetWithPyth`
 *     (see frontend/src/hooks/usePlaceBet.ts), which pays for and submits a
 *     fresh Pyth update inline. It does not depend on keeper freshness at
 *     all; the bare `placeBet` is only the fallback for when Hermes is
 *     unreachable from the browser.
 */
import { redis } from '../db/redis.js'

const KEY = 'ftm:last_user_activity'

/** Long enough that the key outlives any idle window we'd sensibly configure. */
const TTL_SEC = 6 * 60 * 60

/**
 * Record that a real user just did something. Best-effort: a Redis blip must
 * never fail an API request, and the keeper has an independent DB-based
 * fallback signal, so swallowing the error is the correct behaviour here.
 */
export async function markUserActivity(): Promise<void> {
  try {
    await redis.set(KEY, String(Date.now()), { EX: TTL_SEC })
  } catch {
    // ignore — see above
  }
}

/** Epoch ms of the last user-facing request, or null if unknown. */
export async function lastUserActivityMs(): Promise<number | null> {
  try {
    const v = await redis.get(KEY)
    if (!v) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}
