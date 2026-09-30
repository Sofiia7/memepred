/**
 * Rounds keeper health, in the two shapes routes/keeperHealth.ts already uses.
 *
 *   /api/rounds/health   the full snapshot: how many rounds wait for fixStrike
 *                        and settle, every owed call with its hard deadline,
 *                        the oldest overdue one, gas spent in the last 24 h,
 *                        the keeper's balance. Behind the edge, like
 *                        /api/keeper/health.
 *   /health/deep         a code and nothing else. keeperHealth.ts folds the
 *                        verdict below into its answer, only when the rounds
 *                        keeper has published something.
 *
 * ABSENT MEANS NOTHING TO SAY. With the rounds keeper off (the default) there
 * is no `rounds:state` key, and this contributes no code and no warning:
 * /health/deep answers exactly as it did before rounds existed. The same goes
 * for a rounds keeper that was switched off: its snapshot expires
 * (store.ts, ROUNDS_STATE_TTL_SEC) instead of reading as stale forever. And
 * nothing here may throw into /health/deep: an unreadable snapshot is a
 * warning, never an outage of the probe.
 *
 *   down  rounds-keeper-stale       the rounds loop has not published for 5+ min
 *         rounds-config-invalid     ROUNDS_ENABLED=true, but the keeper refused to start
 *         rounds-abi-mismatch       roundView does not decode: the keeper refuses to act
 *         rounds-deadline-missed    a fixStrike or settle is past its hard deadline and not made
 *         rounds-settle-stalled     a due settle has waited an hour or more
 *   warn  rounds-deadline-at-risk   a due fixStrike or settle has less than 45 s left
 *         rounds-settle-overdue     a due settle has waited 15 minutes or more
 *         rounds-over-budget        a round is held back by its budget
 *         rounds-pool-thin          a listed pool is below the listing gate, or the keeper
 *                                   delisted one in the last 24 h (delistIfBelowGate)
 *         rounds-refunds-thin       a round refunded in the last 24 h because a price
 *                                   window carried less depth than its bank needs
 *                                   (RoundSettled reason 4, "thin-window")
 *         rounds-behind-chain       event discovery has not caught up with the head
 *         rounds-snapshot-corrupt   the snapshot does not parse
 *
 * The deadline codes are judged NOW, not at the tick: the snapshot carries each
 * owed call's deadline in chain seconds, and chain time now is estimated as the
 * tick's chain time plus the wall-clock time since the tick. A call is "missed"
 * past the deadlines the contract states in keeperDeadlines(roundId)
 * (strikeEnd + 599 s and settleAt + 839 s with the defaults):
 * from there on a busy pool, the round turns into REFUND and every player pays
 * 1%. A round the keeper left to its players because its budget is exhausted
 * still counts: the call is not made, whoever was supposed to make it.
 */
import type { FastifyInstance } from 'fastify'
import { redis } from '../db/redis.js'
import { URGENT_SECS } from './budget.js'
import { ROUNDS_STATE_KEY, type DeadlineEntry, type RoundsSnapshot } from './store.js'

const STALE_MS = 5 * 60_000
const SETTLE_WARN_SECS = 15 * 60
const SETTLE_DOWN_SECS = 60 * 60

export type RoundsCode =
  | 'rounds-keeper-stale'
  | 'rounds-config-invalid'
  | 'rounds-abi-mismatch'
  | 'rounds-deadline-missed'
  | 'rounds-settle-stalled'
export type RoundsWarn =
  | 'rounds-deadline-at-risk'
  | 'rounds-settle-overdue'
  | 'rounds-over-budget'
  | 'rounds-pool-thin'
  | 'rounds-refunds-thin'
  | 'rounds-behind-chain'
  | 'rounds-snapshot-corrupt'

export interface DeadlineNow {
  roundId: string
  action: string
  /** Seconds left to the deadline now; negative once missed. */
  secsLeft: number
}

export type RoundsVerdict =
  | { state: 'absent' }
  | { state: 'ok'; warn: RoundsWarn[]; snapshot?: Partial<RoundsSnapshot>; ageMs?: number; atRisk?: DeadlineNow[] }
  | {
      state: 'down'; code: RoundsCode; reason: string; warn: RoundsWarn[]; snapshot: Partial<RoundsSnapshot>; ageMs: number
      atRisk?: DeadlineNow[]; missed?: DeadlineNow[]
    }

type Reader = (key: string) => Promise<string | null>

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function isEntry(e: unknown): e is DeadlineEntry {
  const x = e as DeadlineEntry
  return !!x && typeof x === 'object' && typeof x.deadlineAt === 'number' && typeof x.dueAt === 'number'
}

export async function evaluateRoundsHealth(get: Reader, now: number): Promise<RoundsVerdict> {
  let raw: string | null
  try {
    raw = await get(ROUNDS_STATE_KEY)
  } catch {
    // Redis itself failing is the existing probe's business, not this one's.
    return { state: 'absent' }
  }
  if (raw === null) return { state: 'absent' }

  let s: Partial<RoundsSnapshot>
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
    s = parsed as Partial<RoundsSnapshot>
  } catch {
    return { state: 'ok', warn: ['rounds-snapshot-corrupt'] }
  }

  const ageMs = now - num(s.lastTick)
  const down = (code: RoundsCode, reason: string, extra: { atRisk?: DeadlineNow[]; missed?: DeadlineNow[] } = {}): RoundsVerdict =>
    ({ state: 'down', code, reason, warn, snapshot: s, ageMs, ...extra })
  const warn: RoundsWarn[] = []

  if (typeof s.configError === 'string') {
    return down('rounds-config-invalid', `ROUNDS_ENABLED=true but the rounds keeper refused to start: ${s.configError}`)
  }

  // Chain time now, from the tick's chain time and the wall clock since.
  const chainNow = num(s.chainTime) + Math.max(0, ageMs) / 1000
  const entries = Array.isArray(s.deadlines) ? s.deadlines.filter(isEntry) : []
  const missed: DeadlineNow[] = []
  const atRisk: DeadlineNow[] = []
  for (const e of entries) {
    const secsLeft = Math.floor(e.deadlineAt - chainNow)
    const item = { roundId: String(e.roundId), action: String(e.action), secsLeft }
    if (secsLeft < 0) missed.push(item)
    else if (chainNow >= e.dueAt && secsLeft < URGENT_SECS) atRisk.push(item)
  }

  const overdue = s.oldestSettleOverdue && typeof s.oldestSettleOverdue === 'object' ? num(s.oldestSettleOverdue.secs) : 0
  if (atRisk.length) warn.push('rounds-deadline-at-risk')
  if (overdue >= SETTLE_WARN_SECS) warn.push('rounds-settle-overdue')
  if (num(s.overBudget) > 0) warn.push('rounds-over-budget')
  const pools = s.pools && typeof s.pools === 'object' ? s.pools : null
  if (pools && ((Array.isArray(pools.belowGate) && pools.belowGate.length > 0) || num(pools.delisted24h) > 0)) {
    warn.push('rounds-pool-thin')
  }
  if (s.refunds24h && typeof s.refunds24h === 'object' && num(s.refunds24h['thin-window']) > 0) {
    warn.push('rounds-refunds-thin')
  }
  if (s.caughtUp === false) warn.push('rounds-behind-chain')

  if (ageMs > STALE_MS) return down('rounds-keeper-stale', `rounds keeper silent for ${Math.round(ageMs / 1000)}s`, { atRisk, missed })
  if (s.abiMismatch === true) {
    return down('rounds-abi-mismatch', 'roundView does not match the ABI - the rounds keeper is not acting')
  }
  if (missed.length) {
    const worst = missed.reduce((a, b) => (a.secsLeft < b.secsLeft ? a : b))
    return down(
      'rounds-deadline-missed',
      `${missed.length} call(s) past the hard deadline, worst ${worst.action} ${-worst.secsLeft}s late - on a busy pool those rounds refund`,
      { atRisk, missed },
    )
  }
  if (overdue >= SETTLE_DOWN_SECS) {
    return down('rounds-settle-stalled', `a round is ${Math.round(overdue / 60)} min past its settleAt - rounds are not being settled`)
  }
  return { state: 'ok', warn, snapshot: s, ageMs, atRisk }
}

interface Opts {
  get?: Reader
  now?: () => number
}

/** GET /api/rounds/health. `off` (200) when the rounds keeper is not running. */
export async function roundsHealthRoutes(app: FastifyInstance, opts: Opts = {}) {
  const get = opts.get ?? ((key: string) => redis.get(key))
  const now = opts.now ?? Date.now

  app.get('/api/rounds/health', async (_req, reply) => {
    const v = await evaluateRoundsHealth(get, now())
    if (v.state === 'absent') return reply.send({ status: 'off' })
    if (v.state === 'down') {
      return reply.code(503).send({
        status: 'down', reason: v.reason, warn: v.warn, atRisk: v.atRisk, missed: v.missed, snapshot: v.snapshot, ageMs: v.ageMs,
      })
    }
    return reply.send({ status: 'ok', warn: v.warn, atRisk: v.atRisk, snapshot: v.snapshot, ageMs: v.ageMs })
  })
}
