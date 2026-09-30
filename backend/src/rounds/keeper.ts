/**
 * The rounds keeper: one tick finds the rounds, reads the ones that may owe
 * work, sends what is due in order of its hard deadline and within each
 * round's budget, withdraws fees past a threshold and publishes what it saw.
 *
 * What the project pays for, and nothing else (docs/rhc/ROUNDS-CONTRACT.md):
 *
 *   fixStrike(roundId)   activated rounds, from strikeEnd, by fixStrikeBy
 *   settle(roundId)      from settleAt, by settleBy
 *                        (keeperDeadlines: strikeEnd + 599 s and settleAt + 839 s by default)
 *   settle(roundId)      from settleAt + 24 h: REFUND without reading the pool
 *   withdrawFees()       once feesAccrued passes a threshold
 *   delistIfBelowGate(p) a listed pool the gate check finds below the gate,
 *                        within a small daily budget
 *
 * Players bet and claim themselves. A round that did not activate owes no
 * keeper call at all: its players take their stakes back with claim().
 *
 * ── Deadlines first ───────────────────────────────────────────────────
 * Past those deadlines a busy pool's ring no longer holds the window and the
 * round turns into REFUND, every player paying 1%. So within a tick:
 *
 *   1. receipts left over from earlier ticks are looked up first, all at once;
 *   2. fixStrike and settle go out before anything else, earliest deadline
 *      first, first attempts before retries of other rounds, calls still
 *      inside their deadline before calls already past it, then the 24 h
 *      settles, then withdrawFees;
 *   3. everything is sent first and the receipts are awaited together, so one
 *      slow receipt cannot hold back another round's send;
 *   4. before its deadline a call is never deferred for price, never paused
 *      after reverts, and may use the whole allowance, bidding double the fee
 *      once urgent (budget.ts has the rule).
 *
 * Borrowed from the keeper of the existing markets, on purpose and not by
 * copy: the shared wallet with its nonce manager and fee escalation
 * (keeperWallet.sendKeeperTx, passed in as sendTx), the gas guard's daily
 * accounting (gasGuardInstance), the gas limit that grows on a revert and the
 * pause after three reverts in a row (settlementGas.ts), and the parking of
 * work that keeps failing for an unknown reason (attemptTracker.ts). A dry run
 * comes first, every time: it is free, and a transaction that would revert
 * costs the round money it cannot spend twice.
 */
import type { Address, Hex } from 'viem'
import type { Fees } from '../keeper/feeEscalator.js'
import type { Priority } from '../keeper/gasGuard.js'
import { AttemptTracker } from '../keeper/attemptTracker.js'
import { REVERT_PAUSE_AFTER, revertPauseMs } from '../keeper/settlementGas.js'
import {
  checkDeadlines,
  checkRoundTimes,
  checkRoundView,
  OUTCOME_NAMES,
  Outcome,
  reasonName,
  roundLabel,
  RoundsAbiMismatchError,
  type CallDeadlines,
  type RoundState,
  type RoundTimes,
} from './contract.js'
import type { RoundsConfig } from './config.js'
import { isTimeout, type ReceiptEvent, type RoundsChain, type RoundsReceipt, type WriteCall } from './chain.js'
import { discoverRounds, type DiscoveryResult } from './discovery.js'
import { nextDeadline, planByClock, planRound, type Plan, type PlanConfig } from './planner.js'
import {
  bidFor,
  receiptCostWei,
  RoundBudgetError,
  roundsGasLimit,
  URGENT_SECS,
  type KeeperAction,
  type RoundAction,
} from './budget.js'
import type { DeadlineEntry, RoundsSnapshot, RoundsStore } from './store.js'

export type SendTx = (send: (fees: Fees) => Promise<Hex>, label: string) => Promise<Hex>

export interface RoundsGasGuard {
  /** Null to proceed. Round work is 'critical' (logged, never blocked); fee withdrawal is 'routine'. */
  check(priority: Priority): Promise<string | null>
  record(receipt: { gasUsed: bigint; effectiveGasPrice: bigint; l1Fee?: bigint | null }, priority: Priority): Promise<void>
}

export interface RoundsLogger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export interface RoundsKeeperDeps {
  chain: RoundsChain
  store: RoundsStore
  sendTx: SendTx
  gasGuard: RoundsGasGuard
  config: RoundsConfig
  nowMs?: () => number
  log?: RoundsLogger
}

export type ExecOutcome =
  | {
      kind: 'sent'
      hash: Hex
      status: 'success' | 'reverted'
      gasLimit: bigint
      gasUsed: bigint
      costWei: bigint
      /** The maxFeePerGas attached, and whether it was the urgent (doubled) bid. */
      maxFeePerGas: bigint
      urgent: boolean
      events: ReceiptEvent[]
    }
  | { kind: 'sim-failed'; error: string }
  | { kind: 'over-budget'; spentWei: bigint; worstWei: bigint; capWei: bigint }
  | { kind: 'send-failed'; error: string }
  /** The receipt did not come in time: the transaction may still land. */
  | { kind: 'pending'; hash: Hex }
  | { kind: 'skipped'; why: string }

export interface TickReport {
  chainTime: number
  discovery: DiscoveryResult
  /** In the order the calls were sent (receipts are awaited together afterwards). */
  actions: Array<{ roundId: bigint | null; action: KeeperAction; outcome: ExecOutcome }>
  /** Every round still tracked after the tick, with what is due on it now. */
  plans: Array<{ roundId: bigint; plan: Plan }>
  dropped: Array<{ roundId: bigint; why: string }>
  snapshot: RoundsSnapshot
}

interface Pending {
  hash: Hex
  action: RoundAction
  reserved: bigint
  gasLimit: bigint
  maxFeePerGas: bigint
  urgent: boolean
  sinceMs: number
}

/** What the keeper remembers about a round in this process. Spend lives in the store. */
interface Mem {
  /**
   * The round's deadlines as roundTimes(roundId) stated them: read once, then
   * refreshed from every roundView. Never computed here (contract.ts).
   */
  times: RoundTimes | null
  /** keeperDeadlines(roundId), read once with the times: the hard deadlines, never computed here. */
  deadlines: CallDeadlines | null
  view: RoundState | null
  /** Chain seconds before which the view is not re-read (nothing can become due earlier). */
  nextReadAt: number
  /**
   * The action the counters below belong to. Per action, not per round:
   * fixStrike running out of gas says nothing about what settle needs, and the
   * 24 h settle does not read the pool at all.
   */
  streakAction: RoundAction | null
  /** Tries of streakAction that did not get it done: failed dry runs, sends, reverts, lost receipts. */
  attempts: number
  revertStreak: number
  pausedUntilMs: number
  /**
   * Chain seconds until which a call past its deadline is not tried again
   * because it did not fit the budget; set to the 24 h mark, when the reserve opens.
   */
  budgetWaitUntil: number
  /** Wall-clock ms before which a 24 h settle that did not fit is not tried again. */
  graceRetryAtMs: number
  /** Consecutive dry runs that said PriceUnavailableNow, for quieter logs. */
  priceFails: number
  /**
   * A transaction whose receipt did not come in time. The next tick looks for
   * that receipt before sending anything else for the round: a second send
   * while the first may still land would revert AlreadySettled and be paid
   * for out of the same allowance.
   */
  pending: Pending | null
}

const DAY_MS = 24 * 3600_000
/** A pending receipt this old is taken as lost (its reservation stays booked). */
const PENDING_GIVE_UP_MS = 10 * 60_000
/** ... or this old, for a call with a hard deadline: waiting longer would spend the window. */
const PENDING_CRITICAL_GIVE_UP_MS = 30_000
/** Rounds forgotten in this process; cleared past this size so the set cannot grow without bound. */
const FORGOTTEN_MAX = 50_000
const DEADLINES_PUBLISHED = 100

const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split('\n')[0]

export function createRoundsKeeper(deps: RoundsKeeperDeps) {
  const { chain, store, sendTx, gasGuard, config: cfg } = deps
  const nowMs = deps.nowMs ?? Date.now
  const log: RoundsLogger = deps.log ?? {
    info: (m) => console.log(`[rounds] ${m}`),
    warn: (m) => console.warn(`[rounds] ${m}`),
    error: (m) => console.error(`[rounds] ${m}`),
  }

  const mem = new Map<bigint, Mem>()
  const forgotten = new Set<bigint>()
  /** Dry runs that fail for a reason the keeper does not know: parked after five in a row (past a deadline only). */
  const unknownFailures = new AttemptTracker({ maxAttempts: 5, cooldownMs: 10 * 60_000, now: nowMs })
  let feesRevertStreak = 0
  let feesPausedUntilMs = 0

  function memOf(id: bigint): Mem {
    let m = mem.get(id)
    if (!m) {
      m = {
        times: null, deadlines: null, view: null, nextReadAt: 0, streakAction: null, attempts: 0, revertStreak: 0,
        pausedUntilMs: 0, budgetWaitUntil: 0, graceRetryAtMs: 0, priceFails: 0, pending: null,
      }
      mem.set(id, m)
    }
    return m
  }

  function forget(id: bigint) {
    mem.delete(id)
    if (forgotten.size >= FORGOTTEN_MAX) forgotten.clear()
    forgotten.add(id)
  }

  /** Switch the per-action counters to `action`, clearing them if it is a different one. */
  function streakFor(m: Mem, action: RoundAction) {
    if (m.streakAction !== action) {
      m.streakAction = action
      m.attempts = 0
      m.revertStreak = 0
      m.pausedUntilMs = 0
      m.priceFails = 0
    }
  }

  /** planRound, plus what only this process knows about budgets and pauses. */
  async function planOf(id: bigint, v: RoundState, m: Mem, now: number, pc: PlanConfig): Promise<Plan> {
    const spentWei = v.activated && v.outcome === Outcome.NONE ? await store.getSpent(id) : 0n
    const memo = { spentWei, revertStreak: m.revertStreak, pausedUntilMs: m.pausedUntilMs }
    const d = m.deadlines!
    let plan = planRound(v, d, memo, now, nowMs(), pc)
    // A pause earned by another action does not hold this one.
    if (plan.kind === 'paused' && plan.action !== m.streakAction) plan = planRound(v, d, { ...memo, pausedUntilMs: 0 }, now, nowMs(), pc)
    if (plan.kind === 'act') {
      const wait = plan.action === 'graceSettle' ? nowMs() < m.graceRetryAtMs : plan.pastDeadline && now < m.budgetWaitUntil
      if (wait) {
        return { kind: 'over-budget', action: plan.action, capWei: plan.capWei, overdueSecs: plan.overdueSecs, exhausted: false, deadlineAt: plan.deadlineAt }
      }
    }
    return plan
  }

  /**
   * How long a view stays good enough to plan from: nothing can become due
   * before a wait ends, and a round held back past its deadline by its budget
   * can only move again at the 24 h branch. Everything else is read again on
   * the next tick.
   */
  function nextReadAfter(plan: Plan, v: RoundState, m: Mem, settleGrace: number): number {
    if (plan.kind === 'wait') return plan.until
    if (plan.kind === 'over-budget' && plan.action !== 'graceSettle') {
      if (plan.exhausted) return v.times.settleAt + settleGrace
      if (m.budgetWaitUntil > 0) return m.budgetWaitUntil
    }
    return 0
  }

  // ── sending ─────────────────────────────────────────────────────────

  interface Launched {
    id: bigint
    action: RoundAction
    hash: Hex
    reserved: bigint
    gasLimit: bigint
    maxFeePerGas: bigint
    urgent: boolean
  }

  /** Dry run, size, bid, book the worst case, send. Does not wait for the receipt. */
  async function launch(id: bigint, plan: Extract<Plan, { kind: 'act' }>, m: Mem, now: number): Promise<Launched | ExecOutcome> {
    const { action } = plan
    streakFor(m, action)
    const call: WriteCall = { fn: action === 'fixStrike' ? 'fixStrike' : 'settle', roundId: id }

    const sim = await chain.simulate(call)
    if (!sim.ok) return { kind: 'sim-failed', error: sim.error }

    const gasLimit = roundsGasLimit(action, sim.estimate, m.revertStreak)
    // Critical: logged when gas is expensive, never blocked. The round's own
    // cap is what applies, checked below against the fees really attached.
    await gasGuard.check('critical')
    const urgent = plan.deadlineAt !== null && !plan.pastDeadline && (plan.deadlineAt - now < URGENT_SECS || m.attempts > 0)

    let reserved = 0n
    let bid: Fees | null = null
    try {
      const hash = await sendTx(async (quote) => {
        const spent = await store.getSpent(id)
        const b = bidFor(quote, urgent, gasLimit, plan.capWei - spent - cfg.l1ReserveWei)
        if (!b) throw new RoundBudgetError(id, spent, gasLimit * quote.maxFeePerGas + cfg.l1ReserveWei, plan.capWei)
        const worst = gasLimit * b.maxFeePerGas + cfg.l1ReserveWei
        // Booked before the send, trued up from the receipt: a crash in between
        // over-counts this round, it can never under-count it.
        await store.addSpent(id, worst)
        reserved = worst
        bid = b
        try {
          return await chain.send(call, gasLimit, b)
        } catch (err) {
          if (!isTimeout(err)) {
            await store.addSpent(id, -worst)
            reserved = 0n
          }
          throw err
        }
      }, `rounds ${action} ${roundLabel(id)}`)
      return { id, action, hash, reserved, gasLimit, maxFeePerGas: (bid as Fees | null)?.maxFeePerGas ?? 0n, urgent }
    } catch (err) {
      if (err instanceof RoundBudgetError) {
        return { kind: 'over-budget', spentWei: err.spentWei, worstWei: err.worstWei, capWei: err.capWei }
      }
      return { kind: 'send-failed', error: firstLine(err) }
    }
  }

  /** Bill a round's receipt against its reservation and learn from it. */
  async function finishReceipt(l: Launched | (Pending & { id: bigint }), m: Mem, receipt: RoundsReceipt): Promise<ExecOutcome> {
    const costWei = receiptCostWei(receipt)
    await store.addSpent(l.id, costWei - l.reserved)
    await store.logSpend(nowMs(), costWei, `${l.action}:${l.hash}`)
    await gasGuard.record(receipt, 'critical')
    const base = { hash: l.hash, gasLimit: l.gasLimit, gasUsed: receipt.gasUsed, costWei, maxFeePerGas: l.maxFeePerGas, urgent: l.urgent, events: receipt.events }

    if (receipt.status !== 'success') {
      m.attempts++
      m.revertStreak++
      if (m.revertStreak >= REVERT_PAUSE_AFTER) m.pausedUntilMs = nowMs() + revertPauseMs(m.revertStreak)
      return { kind: 'sent', status: 'reverted', ...base }
    }
    m.attempts = 0
    m.revertStreak = 0
    m.pausedUntilMs = 0
    m.priceFails = 0
    // The state comes from the receipt, not from a read after it: a
    // load-balanced RPC can answer that read from a replica a block behind.
    for (const e of receipt.events) {
      if (e.eventName === 'StrikeFixed' && e.roundId === l.id && m.view) m.view = { ...m.view, strikeFixed: true }
      if (e.eventName === 'RoundSettled' && e.roundId === l.id && m.view) m.view = { ...m.view, outcome: e.outcome }
    }
    return { kind: 'sent', status: 'success', ...base }
  }

  /** What a failed dry run says about the round. Returns true when the round is finished with. */
  function learnFromDryRun(id: bigint, plan: Extract<Plan, { kind: 'act' }>, error: string, m: Mem): boolean {
    const { action } = plan
    m.attempts++
    switch (error) {
      case 'AlreadySettled':
      case 'NotActivated':
        // Settled by somebody else (settle is open to anyone), or not ours to settle.
        return true
      case 'StrikeAlreadyFixed':
        if (m.view) m.view = { ...m.view, strikeFixed: true }
        return false
      case 'NotDue':
        // Our clock is a block ahead of the node's. Nothing to learn.
        return false
      case 'PriceUnavailableNow':
        // The pool has no liquidity or cannot be read right now; nothing
        // changes on chain, so trying again costs one eth_call, every tick.
        m.priceFails++
        if ((m.priceFails & (m.priceFails - 1)) === 0) {
          log.warn(`${action} ${roundLabel(id)}: pool cannot price it now (dry run #${m.priceFails}), retrying next tick`)
        }
        return false
      default:
        // Before a deadline, dry runs are free and a parked round would miss
        // its window: keep trying every tick. After it, park.
        if (plan.deadlineAt !== null && !plan.pastDeadline) {
          log.warn(`${action} ${roundLabel(id)}: dry run failed: ${error}`)
        } else if (unknownFailures.fail(`${id}:${action}`)) {
          log.error(`${action} ${roundLabel(id)}: dry run keeps failing (${error}); parked for 10 min`)
        } else {
          log.warn(`${action} ${roundLabel(id)}: dry run failed: ${error}`)
        }
        return false
    }
  }

  // ── fees ────────────────────────────────────────────────────────────

  async function withdrawFeesIfDue(): Promise<{ accrued: bigint | null; outcome: ExecOutcome | null }> {
    if (cfg.feesWithdrawMinWei === null) return { accrued: null, outcome: null }
    const accrued = await chain.feesAccrued()
    if (accrued < cfg.feesWithdrawMinWei || nowMs() < feesPausedUntilMs) return { accrued, outcome: null }

    // Routine: nobody's money waits on it, so the fee ceiling and the daily
    // routine budget of the gas guard apply.
    const skip = await gasGuard.check('routine')
    if (skip) return { accrued, outcome: { kind: 'skipped', why: skip } }

    const sim = await chain.simulate({ fn: 'withdrawFees' })
    if (!sim.ok) return { accrued, outcome: { kind: 'sim-failed', error: sim.error } }
    const gasLimit = roundsGasLimit('withdrawFees', sim.estimate, feesRevertStreak)

    let hash: Hex
    let maxFeePerGas = 0n
    try {
      hash = await sendTx((fees) => { maxFeePerGas = fees.maxFeePerGas; return chain.send({ fn: 'withdrawFees' }, gasLimit, fees) }, 'rounds withdrawFees')
    } catch (err) {
      return { accrued, outcome: { kind: 'send-failed', error: firstLine(err) } }
    }
    let receipt: RoundsReceipt
    try {
      receipt = await chain.waitForReceipt(hash, cfg.receiptTimeoutMs)
    } catch {
      return { accrued, outcome: { kind: 'pending', hash } }
    }
    const costWei = receiptCostWei(receipt)
    await store.logSpend(nowMs(), costWei, `withdrawFees:${hash}`)
    await gasGuard.record(receipt, 'routine')
    if (receipt.status !== 'success') {
      feesRevertStreak++
      if (feesRevertStreak >= REVERT_PAUSE_AFTER) feesPausedUntilMs = nowMs() + revertPauseMs(feesRevertStreak)
    } else {
      feesRevertStreak = 0
      feesPausedUntilMs = 0
      log.info(`withdrew ${accrued} wei of fees to the treasury, tx=${hash}`)
    }
    return {
      accrued,
      outcome: {
        kind: 'sent', hash, status: receipt.status, gasLimit, gasUsed: receipt.gasUsed, costWei,
        maxFeePerGas, urgent: false, events: receipt.events,
      },
    }
  }

  // ── the tick ────────────────────────────────────────────────────────

  /**
   * Where a due call stands in the queue: [class, deadline]. Class 0: first
   * attempt inside its deadline; 1: retry inside its deadline; 2: past its
   * deadline; 3: the 24 h settle. Within a class, the earliest deadline first.
   */
  function rank(plan: Extract<Plan, { kind: 'act' }>, m: Mem, times: RoundTimes, settleGrace: number): [number, number] {
    if (plan.deadlineAt === null) return [3, times.settleAt + settleGrace]
    if (plan.pastDeadline) return [2, plan.deadlineAt]
    return [m.streakAction === plan.action && m.attempts > 0 ? 1 : 0, plan.deadlineAt]
  }

  async function tick(): Promise<TickReport> {
    const startedMs = nowMs()
    const { settleGrace } = await chain.params()
    const pc: PlanConfig = { settleGraceSec: settleGrace, graceReserveBps: cfg.graceReserveBps }
    const head = await chain.latest()
    const now = head.timestamp
    let abiMismatch = false
    let lastError: string | null = null
    const dropped: Array<{ roundId: bigint; why: string }> = []
    const actions: TickReport['actions'] = []
    const plans = new Map<bigint, Plan>()

    // A getLogs failure must not stop work on rounds already known: they are
    // in the store, and their state is read from roundView anyway.
    let discovery: DiscoveryResult
    try {
      discovery = await discoverRounds(
        chain, head.number, store,
        {
          chunk: cfg.logChunk,
          overlap: cfg.logOverlap,
          lookback: cfg.lookbackBlocks,
          startBlock: cfg.deployment.startBlock,
          maxChunks: cfg.maxChunksPerTick,
          confirmations: cfg.confirmations,
        },
        forgotten,
      )
    } catch (err) {
      lastError = `discovery: ${firstLine(err)}`
      log.warn(lastError)
      discovery = { fromBlock: null, toBlock: null, head: head.number, chunks: 0, added: 0, removed: 0, settled: [], caughtUp: false }
    }
    noteSettled(discovery.settled)

    const ids = await store.openRounds()

    // ── 1. receipts left over from earlier ticks, all at once ──
    const stillPending = new Set<bigint>()
    await Promise.all(ids.map(async (id) => {
      const m = mem.get(id)
      const p = m?.pending
      if (!m || !p) return
      let late: RoundsReceipt | null = null
      try {
        late = await chain.waitForReceipt(p.hash, 1_000)
      } catch { /* still nothing */ }
      if (late) {
        m.pending = null
        actions.push({ roundId: id, action: p.action, outcome: await finishReceipt({ ...p, id }, m, late) })
        return
      }
      const age = nowMs() - p.sinceMs
      const critical = p.action !== 'graceSettle'
      if (age < (critical ? PENDING_CRITICAL_GIVE_UP_MS : PENDING_GIVE_UP_MS)) {
        stillPending.add(id)
        return
      }
      log.warn(`${p.action} ${roundLabel(id)}: no receipt for ${p.hash} in ${Math.round(age / 1000)} s, taken as lost (its reservation stays booked)`)
      m.pending = null
      m.attempts++
    }))

    // ── 2. read what may owe work, and plan ──
    for (const id of ids) {
      const m = memOf(id)
      try {
        // One read per round per process: before closeAt nothing can be due,
        // so a round that is still collecting costs this and nothing more.
        if (!m.times) m.times = checkRoundTimes(id, await chain.roundTimes(id))
        if (!m.deadlines) m.deadlines = checkDeadlines(id, await chain.keeperDeadlines(id), m.times)
        const early = planByClock(m.times, now)
        if (early) {
          plans.set(id, early)
          continue
        }
        if (m.view === null || now >= m.nextReadAt) {
          m.view = checkRoundView(id, await chain.roundView(id), m.times)
          m.times = m.view.times
        }
      } catch (err) {
        if (err instanceof RoundsAbiMismatchError) {
          abiMismatch = true
          lastError = err.message
          log.error(err.message)
          break
        }
        lastError = `read ${roundLabel(id)}: ${firstLine(err)}`
        log.warn(lastError)
        continue
      }
      if (!m.view) continue
      const plan = await planOf(id, m.view, m, now, pc)
      m.nextReadAt = nextReadAfter(plan, m.view, m, settleGrace)
      plans.set(id, plan)
    }

    // ── 3. send, earliest deadline first; receipts awaited together ──
    if (!abiMismatch) {
      const due = [...plans.entries()]
        .filter((e): e is [bigint, Extract<Plan, { kind: 'act' }>] => e[1].kind === 'act' && !stillPending.has(e[0]))
        .map(([id, plan]) => ({ id, plan, m: memOf(id), key: rank(plan, memOf(id), memOf(id).times!, settleGrace) }))
        .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1])

      const launched: Launched[] = []
      for (const { id, plan, m } of due) {
        if (launched.length >= cfg.maxTxPerTick) break
        if (unknownFailures.isParked(`${id}:${plan.action}`)) continue
        let res: Launched | ExecOutcome
        try {
          res = await launch(id, plan, m, now)
        } catch (err) {
          // A store or RPC failure in the middle of one round must not stop the others.
          res = { kind: 'send-failed', error: firstLine(err) }
        }
        if ('hash' in res && !('kind' in res)) {
          launched.push(res)
          continue
        }
        const outcome = res as ExecOutcome
        actions.push({ roundId: id, action: plan.action, outcome })
        if (outcome.kind === 'sim-failed') {
          if (learnFromDryRun(id, plan, outcome.error, m)) {
            dropped.push({ roundId: id, why: outcome.error })
            plans.delete(id)
          }
        } else if (outcome.kind === 'over-budget') {
          log.warn(
            `${plan.action} ${roundLabel(id)}: not sent - spent ${outcome.spentWei} + worst case at the plain quote ` +
            `${outcome.worstWei} > cap ${outcome.capWei} wei`,
          )
          // Before its deadline the call is tried again next tick (the price may
          // fall); past it, it waits for the 24 h branch; that branch itself
          // retries every 10 minutes.
          if (plan.action === 'graceSettle') m.graceRetryAtMs = nowMs() + 10 * 60_000
          else if (plan.pastDeadline && m.view) m.budgetWaitUntil = m.view.times.settleAt + settleGrace
        } else if (outcome.kind === 'send-failed') {
          m.attempts++
          lastError = `${plan.action} ${roundLabel(id)}: ${outcome.error}`
          log.error(lastError)
        }
      }

      const results = await Promise.all(launched.map(async (l) => {
        const m = memOf(l.id)
        try {
          const r = await chain.waitForReceipt(l.hash, cfg.receiptTimeoutMs)
          return { l, outcome: await finishReceipt(l, m, r) }
        } catch {
          // The reservation stays, and the next tick asks for this receipt first.
          m.pending = { hash: l.hash, action: l.action, reserved: l.reserved, gasLimit: l.gasLimit, maxFeePerGas: l.maxFeePerGas, urgent: l.urgent, sinceMs: nowMs() }
          return { l, outcome: { kind: 'pending', hash: l.hash } as ExecOutcome }
        }
      }))
      for (const { l, outcome } of results) {
        actions.push({ roundId: l.id, action: l.action, outcome })
        const label = `${l.action} ${roundLabel(l.id)}`
        if (outcome.kind === 'sent') {
          unknownFailures.clear(`${l.id}:${l.action}`)
          const settled = outcome.events.find((e) => e.eventName === 'RoundSettled' && e.roundId === l.id) as
            | Extract<ReceiptEvent, { eventName: 'RoundSettled' }>
            | undefined
          if (outcome.status === 'success') {
            log.info(
              `${label}: ok, gas ${outcome.gasUsed} of ${outcome.gasLimit}, ${outcome.costWei} wei` +
              (outcome.urgent ? ' (urgent bid)' : '') +
              (settled ? `, ${OUTCOME_NAMES[settled.outcome]} (${reasonName(settled.reason)})` : '') +
              `, tx=${outcome.hash}`,
            )
          } else {
            const m = memOf(l.id)
            log.error(`${label}: reverted on chain (${m.revertStreak} in a row, gas ${outcome.gasUsed} of limit ${outcome.gasLimit}), tx=${outcome.hash}`)
          }
        } else if (outcome.kind === 'pending') {
          log.warn(`${label}: no receipt within ${cfg.receiptTimeoutMs} ms, tx=${outcome.hash}`)
        }
      }
    }

    // ── 4. re-plan from what the receipts said, and let go of finished rounds ──
    for (const [id, before] of plans) {
      const m = mem.get(id)
      let plan = before
      if (m?.view && before.kind !== 'wait') {
        plan = await planOf(id, m.view, m, now, pc)
        m.nextReadAt = nextReadAfter(plan, m.view, m, settleGrace)
      }
      if (plan.kind === 'drop') {
        dropped.push({ roundId: id, why: plan.why })
        plans.delete(id)
        continue
      }
      // Its whole allowance is gone and the last branch does not fit either.
      // settle() is permissionless: the players can release the round themselves.
      if (plan.kind === 'over-budget' && plan.action === 'graceSettle' && plan.exhausted) {
        log.error(`${roundLabel(id)}: allowance exhausted, even the 24 h settle does not fit - leaving it to the players (settle is open to anyone)`)
        dropped.push({ roundId: id, why: 'allowance-exhausted' })
        plans.delete(id)
        continue
      }
      plans.set(id, plan)
    }
    if (dropped.length) {
      await store.removeOpen(dropped.map((d) => d.roundId))
      for (const d of dropped) {
        forget(d.roundId)
        if (d.why !== 'not-activated') log.info(`${roundLabel(d.roundId)} done (${d.why})`)
      }
    }

    // ── 5. fees, after every round ──
    let feesAccrued: bigint | null = null
    if (!abiMismatch) {
      try {
        const f = await withdrawFeesIfDue()
        feesAccrued = f.accrued
        if (f.outcome) actions.push({ roundId: null, action: 'withdrawFees', outcome: f.outcome })
      } catch (err) {
        lastError = `withdrawFees: ${firstLine(err)}`
        log.warn(lastError)
      }
    }

    // ── 6. the listing gate, last and on its own cadence ──
    if (!abiMismatch && (lastPoolCheck === null || now - lastPoolCheck >= cfg.poolCheckSec)) {
      try {
        for (const a of await checkPools()) actions.push(a)
        lastPoolCheck = now
      } catch (err) {
        lastError = `pool check: ${firstLine(err)}`
        log.warn(lastError)
      }
    }

    const snapshot = await buildSnapshot({
      now, head: head.number, discovery, plans, pc, feesAccrued, abiMismatch, lastError, startedMs,
      txs: actions.filter((a) => a.outcome.kind === 'sent').length,
    })
    await store.publish(snapshot)

    return { chainTime: now, discovery, actions, plans: [...plans].map(([roundId, plan]) => ({ roundId, plan })), dropped, snapshot }
  }

  async function buildSnapshot(a: {
    now: number
    head: bigint
    discovery: DiscoveryResult
    plans: Map<bigint, Plan>
    pc: PlanConfig
    feesAccrued: bigint | null
    abiMismatch: boolean
    lastError: string | null
    startedMs: number
    txs: number
  }): Promise<RoundsSnapshot> {
    const deadlines: DeadlineEntry[] = []
    const s: RoundsSnapshot = {
      version: 1,
      lastTick: 0,
      chainTime: a.now,
      tickMs: 0,
      intervalMs: cfg.intervalMs,
      contract: chain.address,
      headBlock: a.head.toString(),
      cursorBlock: (await store.getCursor())?.toString() ?? null,
      caughtUp: a.discovery.caughtUp,
      open: a.plans.size,
      collecting: 0,
      waiting: 0,
      awaitingFixStrike: 0,
      awaitingSettle: 0,
      awaitingGraceSettle: 0,
      overBudget: 0,
      paused: 0,
      deadlines,
      atRisk: 0,
      deadlineMissed: 0,
      ...settledSummary(),
      pools: {
        listed: (await store.listedPools()).length,
        belowGate: [...belowGate.values()],
        gateDepthWei: gateDepthWei?.toString() ?? null,
        delisted24h: delistedAt.filter((t) => t >= nowMs() - DAY_MS).length,
        lastCheckChainTime: lastPoolCheck,
        delistSpentTodayWei: (await store.getDaySpent('delist', utcDay(nowMs()))).toString(),
      },
      oldestSettleOverdue: null,
      spent24hWei: (await store.spentSince(nowMs() - DAY_MS)).toString(),
      keeperWei: (await chain.keeperBalance())?.toString() ?? null,
      feesAccruedWei: a.feesAccrued?.toString() ?? null,
      txs: a.txs,
      abiMismatch: a.abiMismatch,
      lastError: a.lastError,
    }
    for (const [id, p] of a.plans) {
      const m = mem.get(id)
      if (m?.view) {
        const d = m.deadlines ? nextDeadline(m.view, m.deadlines, a.now, a.pc) : null
        if (d) {
          deadlines.push({ roundId: id.toString(), action: d.action, dueAt: d.dueAt, deadlineAt: d.deadlineAt, state: p.kind })
          if (a.now > d.deadlineAt) s.deadlineMissed++
          else if (a.now >= d.dueAt && d.deadlineAt - a.now < URGENT_SECS) s.atRisk++
        }
      }
      if (p.kind === 'wait') {
        if (p.phase === 'collecting') s.collecting++
        else s.waiting++
        continue
      }
      if (p.kind === 'drop') continue
      if (p.action === 'fixStrike') s.awaitingFixStrike++
      else if (p.action === 'settle') s.awaitingSettle++
      else s.awaitingGraceSettle++
      if (p.kind === 'over-budget') s.overBudget++
      if (p.kind === 'paused') s.paused++
      if (p.action !== 'fixStrike' && p.kind !== 'over-budget' && m?.view) {
        // Late since settleAt, not since the grace mark: a round at the 24 h
        // branch has been unsettled for a day, and that is what matters.
        const secs = a.now - m.view.times.settleAt
        if (!s.oldestSettleOverdue || secs > s.oldestSettleOverdue.secs) s.oldestSettleOverdue = { roundId: id.toString(), secs }
      }
    }
    deadlines.sort((x, y) => x.deadlineAt - y.deadlineAt)
    deadlines.splice(DEADLINES_PUBLISHED)
    s.lastTick = nowMs()
    s.tickMs = s.lastTick - a.startedMs
    return s
  }

  // ── settled rounds, by reason ────────────────────────────────────────

  /** Rounds seen settled (by anyone), by wall-clock time seen: health counts refunds by reason name. */
  const settledSeen = new Map<bigint, { atMs: number; outcome: number; reason: number }>()

  function noteSettled(list: Array<{ roundId: bigint; outcome: number; reason: number }>) {
    for (const x of list) {
      if (settledSeen.has(x.roundId)) continue
      settledSeen.set(x.roundId, { atMs: nowMs(), outcome: x.outcome, reason: x.reason })
      if (x.outcome === Outcome.REFUND && x.reason !== 0) {
        log.warn(`${roundLabel(x.roundId)} settled as REFUND (${reasonName(x.reason)})`)
      }
    }
    const cutoff = nowMs() - DAY_MS
    for (const [id, v] of settledSeen) if (v.atMs < cutoff) settledSeen.delete(id)
  }

  function settledSummary(): { settled24h: number; refunds24h: Record<string, number> } {
    const refunds24h: Record<string, number> = {}
    let settled24h = 0
    const cutoff = nowMs() - DAY_MS
    for (const v of settledSeen.values()) {
      if (v.atMs < cutoff) continue
      settled24h++
      if (v.outcome === Outcome.REFUND) refunds24h[reasonName(v.reason)] = (refunds24h[reasonName(v.reason)] ?? 0) + 1
    }
    return { settled24h, refunds24h }
  }

  // ── the listing gate ─────────────────────────────────────────────────

  /**
   * Every listed pool, asked of the contract: a dry run of delistIfBelowGate
   * succeeds exactly when the pool is below the gate (WETH depth under
   * gateDepth(), or a ring under minCardinality), reverts PoolAboveGate when
   * it is not, PoolNotListed when somebody delisted it already. The keeper
   * does not copy the gate's formula; the contract answers.
   *
   * A pool below the gate is delisted by the keeper, as routine work (the gas
   * guard's ceiling and daily routine budget apply) and within its own daily
   * budget. Delisting stops new bets only; rounds already open run to the
   * end. bet() checks the gate itself too, so a pool left listed for lack of
   * budget takes no bets anyway: the delist is housekeeping, and the warning
   * rounds-pool-thin says it is pending.
   */
  let lastPoolCheck: number | null = null
  const belowGate = new Map<string, { pool: string; depthWei: string | null }>()
  const delistedAt: number[] = []
  let gateDepthWei: bigint | null = null

  const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

  async function checkPools(): Promise<TickReport['actions']> {
    const out: TickReport['actions'] = []
    try {
      gateDepthWei = await chain.gateDepth()
    } catch { /* for display only */ }
    const seen = new Set<string>()
    for (const pool of await store.listedPools()) {
      const key = pool.toLowerCase()
      seen.add(key)
      const sim = await chain.simulate({ fn: 'delistIfBelowGate', pool })
      if (!sim.ok) {
        if (sim.error === 'PoolNotListed') await store.removePools([pool])
        else if (sim.error !== 'PoolAboveGate') log.warn(`gate check ${pool}: ${sim.error}`)
        belowGate.delete(key)
        continue
      }
      let depthWei: string | null = null
      try { depthWei = (await chain.wethDepth(pool)).toString() } catch { /* display only */ }
      belowGate.set(key, { pool, depthWei })
      log.warn(`pool ${pool} is below the listing gate (WETH depth ${depthWei ?? '?'} < gate ${gateDepthWei ?? '?'} or ring too small)`)
      const outcome = await delist(pool, sim.estimate)
      out.push({ roundId: null, action: 'delistIfBelowGate', outcome })
      if (outcome.kind === 'sent' && outcome.status === 'success') {
        belowGate.delete(key)
        await store.removePools([pool])
        delistedAt.push(nowMs())
      }
    }
    for (const key of [...belowGate.keys()]) if (!seen.has(key)) belowGate.delete(key)
    while (delistedAt.length && delistedAt[0] < nowMs() - DAY_MS) delistedAt.shift()
    return out
  }

  async function delist(pool: Address, estimate: bigint | null): Promise<ExecOutcome> {
    if (cfg.delistDailyBudgetWei === null) return { kind: 'skipped', why: 'ROUNDS_DELIST_DAILY_BUDGET_ETH=off' }
    const skip = await gasGuard.check('routine')
    if (skip) return { kind: 'skipped', why: skip }
    const gasLimit = roundsGasLimit('delistIfBelowGate', estimate, 0)
    const day = utcDay(nowMs())
    let reserved = 0n
    let maxFeePerGas = 0n
    let hash: Hex
    try {
      hash = await sendTx(async (quote) => {
        const spent = await store.getDaySpent('delist', day)
        const b = bidFor(quote, false, gasLimit, cfg.delistDailyBudgetWei! - spent - cfg.l1ReserveWei)
        if (!b) throw new RoundBudgetError(0n, spent, gasLimit * quote.maxFeePerGas + cfg.l1ReserveWei, cfg.delistDailyBudgetWei!)
        const worst = gasLimit * b.maxFeePerGas + cfg.l1ReserveWei
        await store.addDaySpent('delist', day, worst)
        reserved = worst
        maxFeePerGas = b.maxFeePerGas
        try {
          return await chain.send({ fn: 'delistIfBelowGate', pool }, gasLimit, b)
        } catch (err) {
          if (!isTimeout(err)) { await store.addDaySpent('delist', day, -worst); reserved = 0n }
          throw err
        }
      }, `rounds delistIfBelowGate ${pool}`)
    } catch (err) {
      if (err instanceof RoundBudgetError) {
        log.warn(`delistIfBelowGate ${pool}: not sent, the daily delist budget is spent (${err.spentWei} of ${err.capWei} wei)`)
        return { kind: 'over-budget', spentWei: err.spentWei, worstWei: err.worstWei, capWei: err.capWei }
      }
      return { kind: 'send-failed', error: firstLine(err) }
    }
    let receipt: RoundsReceipt
    try {
      receipt = await chain.waitForReceipt(hash, cfg.receiptTimeoutMs)
    } catch {
      return { kind: 'pending', hash }
    }
    const costWei = receiptCostWei(receipt)
    await store.addDaySpent('delist', day, costWei - reserved)
    await store.logSpend(nowMs(), costWei, `delistIfBelowGate:${hash}`)
    await gasGuard.record(receipt, 'routine')
    const ev = receipt.events.find((e) => e.eventName === 'PoolBelowGate') as Extract<ReceiptEvent, { eventName: 'PoolBelowGate' }> | undefined
    if (receipt.status === 'success') {
      log.warn(`delisted ${pool} (below the gate: depth ${ev?.depth ?? '?'}, ring ${ev?.cardinality ?? '?'}), tx=${hash}`)
    }
    return { kind: 'sent', hash, status: receipt.status, gasLimit, gasUsed: receipt.gasUsed, costWei, maxFeePerGas, urgent: false, events: receipt.events }
  }

  return { tick }
}

export type RoundsKeeper = ReturnType<typeof createRoundsKeeper>
