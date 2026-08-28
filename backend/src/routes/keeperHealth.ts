/**
 * Keeper health, in two shapes.
 *
 *   /api/keeper/health  full snapshot - the /status page and any operator
 *                       looking at what specifically is wrong.
 *   /health/deep        status code + one line, nothing else - the path an
 *                       external uptime monitor watches.
 *
 * Both answer from the watchdog snapshot the keeper publishes to Redis every
 * ~90s, and both return the same code for the same condition:
 *
 *   200  keeper and resolver balances ok, no invariant drift, watchdog ticked
 *        < 5 min ago
 *   503  keeper wallet out of gas, resolver balance critical, USDC invariant
 *        drift, or the watchdog hasn't ticked in 5+ min
 *
 * Why the second path exists at all: `/health` is a liveness probe that
 * returns `{status:'ok'}` for as long as the Fastify process has a pulse, and
 * it was the only thing UptimeRobot watched. In August the keeper sat dead for
 * 15 days behind a permanently green monitor. A monitor pointed at a probe
 * that cannot fail is worse than no monitor, because it is believed.
 *
 * `/health/deep` deliberately answers with `{status, reason}` and no snapshot:
 * it is geo-exempt in the edge Worker (monitors run from blocked regions -
 * UptimeRobot checks from Ohio, which the US block correctly 451s), so its
 * body is world-readable. Balances, the keeper address and feed state stay on
 * the non-exempt path.
 */
import { FastifyInstance } from 'fastify'
import { redis } from '../db/redis.js'

const STATE_KEY       = 'watchdog:state'
const INVARIANT_KEY   = 'invariant:critical'
const STALE_THRESHOLD = 5 * 60_000 // 5 min

interface Snapshot {
  resolverEthWei:    string
  resolverEthAlert:  'ok' | 'warn' | 'critical' | 'unknown'
  keeperEthWei?:     string
  keeperEthAlert?:   'ok' | 'warn' | 'critical' | 'unknown'
  keeperAddress?:    string
  feedStatus:        Record<string, { failStreak: number; lastPausedAt?: number }>
  gasThrottled?:     boolean
  gasThrottleReason?: string | null
  lastTick:          number
}

/**
 * `code` is the machine word that is safe to publish anywhere; `reason` may
 * name the wallet that is empty and therefore stays on the authenticated-by-
 * geography path. Splitting them is not cosmetic - the first version of this
 * put the keeper address into `reason` and the deep probe echoed it to the
 * open internet.
 */
type Code =
  | 'no-snapshot'
  | 'corrupt-snapshot'
  | 'usdc-invariant-drift'
  | 'watchdog-stale'
  | 'keeper-out-of-gas'
  | 'resolver-eth-critical'

/**
 * Green-but-degraded. A monitor that only distinguishes up from down learns
 * about an empty gas tank at the moment everything stops; these say it a few
 * days earlier and are safe to publish for the same reason `code` is - they
 * name a condition, never a balance or an address.
 */
type Warn = 'keeper-eth-low' | 'resolver-eth-low' | 'feed-degraded' | 'gas-throttled'

interface Verdict {
  ok:         boolean
  code?:      Code
  warn?:      Warn[]
  reason?:    string
  snapshot?:  Snapshot
  invariant?: { drift?: number } | null
  ageMs?:     number
}

type Reader = (key: string) => Promise<string | null>

/**
 * The single judgement both routes render. Kept out of Fastify so the two
 * paths can never drift into disagreeing about whether the keeper is up.
 */
export async function evaluateKeeperHealth(get: Reader, now: number): Promise<Verdict> {
  const raw = await get(STATE_KEY)
  if (!raw) return { ok: false, code: 'no-snapshot', reason: 'no watchdog snapshot - keeper not running?' }

  let snap: Snapshot
  try {
    snap = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'corrupt-snapshot', reason: 'corrupt snapshot' }
  }

  const age   = now - snap.lastTick
  const stale = age > STALE_THRESHOLD
  const crit  = snap.resolverEthAlert === 'critical'
  // An empty keeper wallet is a total outage: no settlements, no market
  // rollovers, no price pushes. It used to report 200 because the watchdog
  // itself only does reads and kept ticking happily - which is exactly how a
  // 15-day production stall went unnoticed. Optional in the type so an old
  // snapshot published by a not-yet-restarted keeper still parses.
  const keeperCrit = snap.keeperEthAlert === 'critical'

  const invariantRaw = await get(INVARIANT_KEY)
  const invariant    = invariantRaw ? JSON.parse(invariantRaw) : null

  if (stale || crit || keeperCrit || invariant) {
    return {
      ok: false,
      code:
        invariant    ? 'usdc-invariant-drift'
        : stale      ? 'watchdog-stale'
        : keeperCrit ? 'keeper-out-of-gas'
        :              'resolver-eth-critical',
      reason:
        invariant    ? `usdc invariant drift $${invariant.drift?.toFixed?.(2) ?? '?'}`
        : stale      ? `watchdog stale ${Math.round(age / 1000)}s`
        : keeperCrit ? `keeper wallet out of gas (${snap.keeperAddress ?? 'unknown'}) - nothing is being settled`
        :              'resolver eth critical',
      snapshot: snap,
      invariant,
      ageMs:    age,
    }
  }

  const warn: Warn[] = []
  if (snap.keeperEthAlert   === 'warn') warn.push('keeper-eth-low')
  if (snap.resolverEthAlert === 'warn') warn.push('resolver-eth-low')
  if (Object.values(snap.feedStatus ?? {}).some(f => f.failStreak > 0)) warn.push('feed-degraded')
  if (snap.gasThrottled) warn.push('gas-throttled')

  return { ok: true, warn, snapshot: snap, ageMs: age }
}

interface Opts {
  /** Defaults to Redis; injected in tests. */
  get?: Reader
  now?: () => number
}

export async function keeperHealthRoutes(app: FastifyInstance, opts: Opts = {}) {
  const get = opts.get ?? ((key: string) => redis.get(key))
  const now = opts.now ?? Date.now

  app.get('/api/keeper/health', async (_req, reply) => {
    const v = await evaluateKeeperHealth(get, now())
    if (!v.ok) {
      return reply.code(503).send({
        status:    'down',
        reason:    v.reason,
        snapshot:  v.snapshot,
        invariant: v.invariant ?? undefined,
        ageMs:     v.ageMs,
      })
    }
    return reply.send({ status: 'ok', warn: v.warn, snapshot: v.snapshot, ageMs: v.ageMs })
  })

  // Monitor-facing. The status code carries the signal; the string is for the
  // alert body. Nothing else goes in here - see the header comment.
  app.get('/health/deep', async (_req, reply) => {
    const v = await evaluateKeeperHealth(get, now())
    return v.ok
      ? reply.send({ status: 'ok', warn: v.warn?.length ? v.warn : undefined })
      : reply.code(503).send({ status: 'down', reason: v.code })
  })
}
