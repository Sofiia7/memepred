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
const UNMEASURED_KEY  = 'invariant:unmeasured'
/**
 * How long the invariant monitor may go without reading every balance before
 * that is an outage rather than a blip. One tick of failed reads used to be a
 * CRITICAL "drift"; a quarter of an hour of them is a money monitor that is not
 * watching, and nothing else here notices - the watchdog publishes its snapshot
 * whatever the RPC does.
 */
const UNMEASURED_DOWN_MS = 15 * 60_000
/** Escalations at one nonce before it counts as an outage rather than a retry. */
const NONCE_WEDGED_LEVEL = 3

/**
 * How far past its deadline the oldest unsettled match may run.
 *
 * Settlement lags its deadline by design - the resolve loop is periodic, and a
 * match that came due between ticks is simply waiting. Past the warn mark that
 * stops being a plausible reading of a working keeper; past the red mark
 * nothing is settling at all. Both sit well inside the contract's 24h
 * SETTLE_GRACE, so the alert arrives while the matches can still be settled
 * rather than only refunded.
 */
const SETTLEMENTS_WARN_SECS = 15 * 60
const SETTLEMENTS_DOWN_SECS = 60 * 60

interface Snapshot {
  resolverEthWei:    string
  resolverEthAlert:  'ok' | 'warn' | 'critical' | 'unknown'
  keeperEthWei?:     string
  keeperEthAlert?:   'ok' | 'warn' | 'critical' | 'unknown'
  keeperAddress?:    string
  feedStatus:        Record<string, { failStreak: number; lastPausedAt?: number }>
  gasThrottled?:     boolean
  gasThrottleReason?: string | null
  stuckNonce?:       number | null
  escalationLevel?:  number
  /**
   * Seconds the oldest unsettled-but-due match has been waiting, 0 when there
   * is no backlog. Optional so a snapshot published before this existed still
   * parses as healthy rather than as an outage.
   */
  settlementsOverdueSecs?: number
  /** No feed answered the watchdog's last tick: the oracle side is down. */
  oracleOutage?:     boolean
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
  | 'nonce-wedged'
  | 'resolver-eth-critical'
  | 'settlements-stalled'
  | 'invariant-unmeasured'

/**
 * Green-but-degraded. A monitor that only distinguishes up from down learns
 * about an empty gas tank at the moment everything stops; these say it a few
 * days earlier and are safe to publish for the same reason `code` is - they
 * name a condition, never a balance or an address.
 */
type Warn = 'keeper-eth-low' | 'resolver-eth-low' | 'feed-degraded' | 'gas-throttled'
          | 'nonce-escalating' | 'settlements-overdue' | 'oracle-outage'
          | 'invariant-unmeasured'

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

  // Escalation clears most wedges within a tick or two; past that, nothing the
  // keeper writes is landing at all and it needs to read as an outage.
  const nonceWedged = (snap.escalationLevel ?? 0) >= NONCE_WEDGED_LEVEL

  const invariantRaw = await get(INVARIANT_KEY)
  const invariant    = invariantRaw ? JSON.parse(invariantRaw) : null

  // The invariant monitor could not read every balance and refused to render a
  // verdict from a partial sum. Briefly, that is a timeout. For long, it is the
  // monitor itself that is down, while every other signal here stays green.
  const unmeasuredRaw = await get(UNMEASURED_KEY)
  let blindMs = 0
  if (unmeasuredRaw) {
    try {
      const since = (JSON.parse(unmeasuredRaw) as { since?: unknown }).since
      blindMs = typeof since === 'number' ? Math.max(0, now - since) : 0
    } catch {
      // Unreadable: count it as having just gone blind - a warning, not silence.
    }
  }
  const monitorBlind = !!unmeasuredRaw && blindMs >= UNMEASURED_DOWN_MS

  // Every other red condition here is about the keeper's ability to act - gas,
  // nonce, liveness. A keeper with a full tank and a clean nonce whose
  // settlements revert in simulation trips none of them, and the USDC
  // invariant does not drift either because nothing settled on-chain. Without
  // this, matches sit unsettled indefinitely behind a 200.
  const overdue          = snap.settlementsOverdueSecs ?? 0
  const settlementsDead  = overdue >= SETTLEMENTS_DOWN_SECS

  if (stale || crit || keeperCrit || nonceWedged || invariant || settlementsDead || monitorBlind) {
    return {
      ok: false,
      code:
        invariant       ? 'usdc-invariant-drift'
        : stale           ? 'watchdog-stale'
        : keeperCrit      ? 'keeper-out-of-gas'
        : nonceWedged     ? 'nonce-wedged'
        : settlementsDead ? 'settlements-stalled'
        : monitorBlind    ? 'invariant-unmeasured'
        :                   'resolver-eth-critical',
      reason:
        invariant       ? `usdc invariant drift $${invariant.drift?.toFixed?.(2) ?? '?'}`
        : stale           ? `watchdog stale ${Math.round(age / 1000)}s`
        : keeperCrit      ? `keeper wallet out of gas (${snap.keeperAddress ?? 'unknown'}) - nothing is being settled`
        : nonceWedged     ? `nonce ${snap.stuckNonce} wedged after ${snap.escalationLevel} fee escalations - no writes are landing`
        : settlementsDead ? `oldest match ${Math.round(overdue / 60)} min past its settleAt - settlement is not running`
        : monitorBlind    ? `invariant monitor blind ${Math.round(blindMs / 60_000)} min - balance reads are failing`
        :                   'resolver eth critical',
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
  if ((snap.escalationLevel ?? 0) > 0) warn.push('nonce-escalating')
  if (overdue >= SETTLEMENTS_WARN_SECS) warn.push('settlements-overdue')
  // Upstream and self-healing, and the watchdog pauses nothing over it - but a
  // dead oracle stops both price pushes and settlement, so it must be visible
  // now rather than an hour later via the settlement backlog.
  if (snap.oracleOutage) warn.push('oracle-outage')
  if (unmeasuredRaw) warn.push('invariant-unmeasured')

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
