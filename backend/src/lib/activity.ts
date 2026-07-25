/**
 * activity — shared "is anyone actually here?" signal.
 *
 * Sprint 5.6. The keeper pushes Pyth prices on-chain every 30s to accumulate
 * the TWAP history that settlement reads for exit prices. At two feeds that
 * is 5,760 transactions a day, and it ran identically whether the product had
 * a thousand users or none — the largest running cost that scaled with
 * nothing.
 *
 * This lets the keeper tell the difference. The API stamps a Redis key on
 * real user traffic; the keeper reads it and keeps the fast cadence only
 * while somebody is around, falling back to a slow heartbeat otherwise.
 *
 * Entry pricing does not depend on this at all any more: `placeBetWithPyth`
 * is the only way to bet and it carries its own fresh Pyth update, so a
 * visitor arriving mid-backoff is priced correctly regardless. What the
 * backoff must not starve is the exit TWAP — which is why
 * onchainPriceRecorder also stays hot for any PENDING or MATCHED order,
 * independently of whether a human is present.
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
