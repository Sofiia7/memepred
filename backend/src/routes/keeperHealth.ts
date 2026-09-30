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
 *        drift, an indexer stuck on one log, or the watchdog hasn't ticked in
 *        5+ min
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
import { CHAIN_PROFILE } from '../chainProfile.js'
import { POISON_KEY } from '../keeper/poisonTracker.js'
import { evaluateRoundsHealth } from '../rounds/health.js'

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

/**
 * How long a due match may wait for the keeper before that is worth a warning.
 *
 * SETTLEMENTS_WARN_SECS above is about a settlement path that has STOPPED; this
 * is about one that is merely slower than the price history it reads. A pool
 * that trades every second keeps only about 300 seconds of observations, and
 * the resolver refunds a match whose exit window has fallen out of them - so a
 * due match still unresolved after roughly 120-240 seconds is at risk of being
 * refunded instead of settled, and the warning has to come well before that.
 *
 * Tunable with READY_MATCH_WARN_SEC. 90 seconds by default on the rhc profile
 * (pool-backed, where that history limit exists); off (0) on Base, whose
 * settlement reads a price the keeper pushed itself and whose 60 second cadence
 * would trip a threshold this low on a healthy keeper. 0 disables it anywhere.
 */
function defaultReadyMatchWarnSec(): number {
  const raw = process.env.READY_MATCH_WARN_SEC
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return CHAIN_PROFILE.name === 'rhc' ? 90 : 0
}

/** Knobs the verdict depends on, injectable so tests do not touch the environment. */
export interface HealthConfig {
  readyMatchWarnSec: number
}

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
  /**
   * Seconds the oldest due, unresolved match has been waiting since it came
   * due - see the watchdog. Unlike settlementsOverdueSecs it sees a match
   * before it is five minutes late. Optional for the same reason.
   */
  readyMatchLagSecs?: number
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
  | 'indexer-stalled'
  | 'invariant-unmeasured'

/**
 * Green-but-degraded. A monitor that only distinguishes up from down learns
 * about an empty gas tank at the moment everything stops; these say it a few
 * days earlier and are safe to publish for the same reason `code` is - they
 * name a condition, never a balance or an address.
 */
type Warn = 'keeper-eth-low' | 'resolver-eth-low' | 'feed-degraded' | 'gas-throttled'
          | 'nonce-escalating' | 'settlements-overdue' | 'oracle-outage'
          | 'invariant-unmeasured' | 'ready-match-lag'

/**
 * What the indexer left in Redis when one log kept failing (keeper/
 * poisonTracker.ts). Every field is untrusted input to this route.
 */
interface PoisonInfo {
  txHash?:        unknown
  logIndex?:      unknown
  market?:        unknown
  event?:         unknown
  failures?:      unknown
  firstFailedAt?: unknown
  error?:         unknown
}

interface Verdict {
  ok:         boolean
  code?:      Code
  warn?:      Warn[]
  reason?:    string
  snapshot?:  Snapshot
  invariant?: { drift?: number } | null
  indexer?:   PoisonInfo | null
  ageMs?:     number
}

/** A field of an untrusted record as a short printable string. */
const shown = (v: unknown, max = 100): string => (typeof v === 'string' || typeof v === 'number') ? String(v).slice(0, max) : '?'

function describePoison(p: PoisonInfo): string {
  const since = typeof p.firstFailedAt === 'number' ? ` since ${new Date(p.firstFailedAt).toISOString()}` : ''
  const where = p.txHash ? `${shown(p.event)} ${shown(p.txHash)}#${shown(p.logIndex)}` : shown(p.event)
  const market = p.market ? ` on ${shown(p.market)}` : ''
  return `indexer stalled: ${where}${market} has failed ${shown(p.failures)} times in a row${since} - ` +
         `the orderbook cursor is frozen, nothing behind it is being indexed`
}

type Reader = (key: string) => Promise<string | null>

/**
 * The single judgement both routes render. Kept out of Fastify so the two
 * paths can never drift into disagreeing about whether the keeper is up.
 */
export async function evaluateKeeperHealth(
  get: Reader,
  now: number,
  cfg: HealthConfig = { readyMatchWarnSec: defaultReadyMatchWarnSec() },
): Promise<Verdict> {
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

  // One log the indexer cannot get through stops the whole orderbook stream and
  // says nothing: the cursor freezes, the reconcilers behind it never run, and
  // the invariant monitor compares at the frozen block and reads ok. The indexer
  // publishes the failing log once it has failed several ticks in a row and
  // takes the record down when it goes through. The KEY existing is the signal,
  // so a record this route cannot read still counts.
  const poisonRaw = await get(POISON_KEY)
  let poison: PoisonInfo | null = null
  if (poisonRaw) {
    try {
      const parsed = JSON.parse(poisonRaw)
      poison = parsed && typeof parsed === 'object' ? parsed as PoisonInfo : {}
    } catch {
      poison = {}
    }
  }
  const indexerStalled = poison !== null

  if (stale || crit || keeperCrit || nonceWedged || invariant || settlementsDead || indexerStalled || monitorBlind) {
    return {
      ok: false,
      code:
        invariant       ? 'usdc-invariant-drift'
        : stale           ? 'watchdog-stale'
        : keeperCrit      ? 'keeper-out-of-gas'
        : nonceWedged     ? 'nonce-wedged'
        : settlementsDead ? 'settlements-stalled'
        : indexerStalled  ? 'indexer-stalled'
        : monitorBlind    ? 'invariant-unmeasured'
        :                   'resolver-eth-critical',
      reason:
        invariant       ? `usdc invariant drift $${invariant.drift?.toFixed?.(2) ?? '?'}`
        : stale           ? `watchdog stale ${Math.round(age / 1000)}s`
        : keeperCrit      ? `keeper wallet out of gas (${snap.keeperAddress ?? 'unknown'}) - nothing is being settled`
        : nonceWedged     ? `nonce ${snap.stuckNonce} wedged after ${snap.escalationLevel} fee escalations - no writes are landing`
        : settlementsDead ? `oldest match ${Math.round(overdue / 60)} min past its settleAt - settlement is not running`
        : indexerStalled  ? describePoison(poison!)
        : monitorBlind    ? `invariant monitor blind ${Math.round(blindMs / 60_000)} min - balance reads are failing`
        :                   'resolver eth critical',
      snapshot: snap,
      invariant,
      indexer:  poison,
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
  // Earlier and finer than the line above: a due match the keeper has not
  // resolved within the price history's reach is at risk of a refund.
  if (cfg.readyMatchWarnSec > 0 && (snap.readyMatchLagSecs ?? 0) >= cfg.readyMatchWarnSec) warn.push('ready-match-lag')
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
  /** Defaults to READY_MATCH_WARN_SEC / the profile's default; injected in tests. */
  readyMatchWarnSec?: number
}

export async function keeperHealthRoutes(app: FastifyInstance, opts: Opts = {}) {
  const get = opts.get ?? ((key: string) => redis.get(key))
  const now = opts.now ?? Date.now
  const cfg: HealthConfig = { readyMatchWarnSec: opts.readyMatchWarnSec ?? defaultReadyMatchWarnSec() }

  app.get('/api/keeper/health', async (_req, reply) => {
    const v = await evaluateKeeperHealth(get, now(), cfg)
    if (!v.ok) {
      return reply.code(503).send({
        status:    'down',
        reason:    v.reason,
        snapshot:  v.snapshot,
        invariant: v.invariant ?? undefined,
        // The failing log, for whoever is debugging it. This route is behind
        // the edge; the public probe below carries only the code.
        indexer:   v.indexer ?? undefined,
        ageMs:     v.ageMs,
      })
    }
    return reply.send({ status: 'ok', warn: v.warn, snapshot: v.snapshot, ageMs: v.ageMs })
  })

  // Monitor-facing. The status code carries the signal; the string is for the
  // alert body. Nothing else goes in here - see the header comment.
  app.get('/health/deep', async (_req, reply) => {
    const v = await evaluateKeeperHealth(get, now(), cfg)
    // PoolRounds keeper (rounds/health.ts): 'absent' while it is off, which
    // leaves this answer exactly as before; never throws.
    const r = await evaluateRoundsHealth(get, now())
    if (v.ok && r.state === 'down') return reply.code(503).send({ status: 'down', reason: r.code })
    const warn = [...(v.warn ?? []), ...(r.state === 'absent' ? [] : r.warn)]
    return v.ok
      ? reply.send({ status: 'ok', warn: warn.length ? warn : undefined })
      : reply.code(503).send({ status: 'down', reason: v.code })
  })
}
