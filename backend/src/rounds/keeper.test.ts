import { describe, it, expect, beforeEach } from 'vitest'
import { getAddress, type Address, type Hex } from 'viem'
import { createRoundsKeeper, type SendTx, type RoundsGasGuard, type TickReport } from './keeper.js'
import { MemoryRoundsStore, ROUNDS_STATE_KEY } from './store.js'
import { roundIdOf, decodeRoundId, timesFromContract, type CallDeadlines, type RawDeadlines, type RawRoundView, type RawTimes, type RoundTimes } from './contract.js'
import type { ContractLog, ReceiptEvent, RoundsChain, RoundsReceipt, SimResult, WriteCall } from './chain.js'
import type { RoundsConfig } from './config.js'
import type { Fees } from '../keeper/feeEscalator.js'
import { isStuckNonceError, escalate } from '../keeper/feeEscalator.js'
import { evaluateRoundsHealth } from './health.js'

/**
 * The rounds keeper against a scripted PoolRounds v3 (after the re-audit).
 *
 * FakePoolRounds keeps the contract's rules that decide what the keeper may
 * and may not do: the deadlines (closeAt, a 300 s pause, a 300 s strike
 * window, settleAt; the keeper only ever learns them through roundTimes), the
 * hard deadlines (the keeper only learns them through keeperDeadlines),
 * activation (PoolRoundMath.isActive at side cap 1), the order of checks in
 * fixStrike and settle, the 24 h branch that needs no pool, a transaction that
 * runs out of gas below what it needs, the listing gate and delistIfBelowGate,
 * and the depth rule's REFUND (reason 4) for a round whose windows were thin.
 * It charges what EIP-1559 would: min(maxFee, base + tip) per gas used.
 *
 * And the ring. On a BUSY pool (an observation every second, the default
 * here) a ring of `ring` records remembers ring - 1 seconds: fixStrike later
 * than strikeStart + ring - 1 and settle later than settleAt - exit window +
 * ring - 1 turn the round into REFUND, as the contract's test_L1_* tests show on
 * the real code. keeperDeadlines reports exactly those seconds, from the same
 * ring: 900 by default (strikeEnd + 599, settleAt + 839), smaller in tests that
 * need a fixStrike deadline before settleAt. A QUIET pool keeps its windows.
 * Every priced settle is UP. anvil.e2e.test.ts runs the real contract.
 */

const PAUSE = 300
const WINDOW = 300
const GRACE = 86_400
const GWEI = 10n ** 9n
const ETH = 10n ** 18n
const T0 = 1_790_000_000 // inside window 5 966 666 of a 300 s round: collecting

type Kind = 'fixStrike' | 'settle' | 'grace' | 'withdrawFees' | 'delist'

interface FakeRound {
  rawUp: bigint
  rawDown: bigint
  minBank: bigint
  costAllowance: bigint
  strikeFixed: boolean
  outcome: number
  reason: number
  /** Chain time the strike was fixed and the round settled, as mined. */
  fixedAt?: number
  settledAt?: number
}

function isActive(r: FakeRound): boolean {
  if (r.rawUp === 0n || r.rawDown === 0n) return false
  const side = r.rawUp < r.rawDown ? r.rawUp : r.rawDown // side cap 1: min(UP, DOWN) accepted on each side
  const bank = 2n * side
  const gross = (bank * 100n) / 10_000n
  return bank >= r.minBank && gross - (gross * 1_000n) / 10_000n >= 2n * r.costAllowance
}

/** The fake contract's own exit window rule (PoolRoundOracle.exitWindowFor). The keeper has none. */
const exitWindow = (duration: number) => Math.min(300, Math.max(30, Math.floor(duration / 5)))

class FakePoolRounds implements RoundsChain {
  readonly address = getAddress('0x00000000000000000000000000000000000000c0')
  block = 100n
  time = T0
  baseFee = 1n * GWEI
  pause = PAUSE
  window = WINDOW
  /** The ring every listed pool is guaranteed: minCardinality. */
  ring = 900
  rounds = new Map<bigint, FakeRound>()
  events: ContractLog[] = []
  /** Rounds whose pool cannot be read right now: PriceUnavailableNow. */
  unpriceable = new Set<bigint>()
  /** Rounds on a pool that writes rarely: its ring never loses their windows. */
  quiet = new Set<bigint>()
  /** Rounds whose price windows carried less depth than the bank needs: REFUND, reason 4. */
  thinWindow = new Set<bigint>()
  /** Pools: listed, and whether below the listing gate. */
  pools = new Map<string, { pool: Address; listed: boolean; below: boolean }>()
  /** Gas a transaction of that kind needs; below it, it runs out of gas and reverts. */
  requiredGas = new Map<Kind, bigint>()
  gasUsed: Record<Kind, bigint> = { fixStrike: 80_000n, settle: 156_000n, grace: 54_000n, withdrawFees: 73_000n, delist: 65_000n }
  feesAccruedWei = 0n
  /** Served instead of the real state for these rounds: a replica a block behind. */
  staleView = new Map<bigint, RawRoundView>()
  wrongPool = false
  garbageTimes = false
  sendErrors: Error[] = []
  receiptTimeouts = 0
  /** The next this-many calls to latest() fail, as an RPC outage would. */
  failLatest = 0

  /** Dry runs of round calls and fee withdrawal; the gate check's go to poolSims. */
  sims: WriteCall[] = []
  poolSims: Address[] = []
  sent: Array<{ call: WriteCall; gas: bigint; fees: Fees; at: number }> = []
  views = 0
  timesReads = 0
  deadlineReads = 0
  private pending = new Map<Hex, { call: WriteCall; gas: bigint; fees: Fees }>()
  private nonce = 0

  rawTimes(id: bigint): RawTimes {
    const { duration, index } = decodeRoundId(id)
    const openAt = index * duration
    const closeAt = openAt + duration
    const strikeStart = closeAt + BigInt(this.pause)
    const strikeEnd = strikeStart + BigInt(this.window)
    return { openAt, closeAt, strikeStart, strikeEnd, settleAt: strikeEnd + duration }
  }
  times(id: bigint): RoundTimes { return timesFromContract(this.rawTimes(id)) }

  /** PoolRounds.keeperDeadlines, from the same ring the busy pool forgets by. */
  deadlines(id: bigint): CallDeadlines {
    const t = this.times(id)
    const { duration } = decodeRoundId(id)
    return { fixStrikeBy: t.strikeStart + this.ring - 1, settleBy: t.settleAt - exitWindow(Number(duration)) + this.ring - 1 }
  }

  listPool(pool: Address) {
    this.pools.set(pool.toLowerCase(), { pool, listed: true, below: false })
    this.emitPool('PoolListed', pool)
  }

  /** Bets of a new round in the current window, on a listed pool. */
  open(pool: Address, o: { up?: bigint; down?: bigint; allowance?: bigint; minBank?: bigint; duration?: number } = {}): bigint {
    if (!this.pools.has(pool.toLowerCase())) this.pools.set(pool.toLowerCase(), { pool, listed: true, below: false })
    const duration = o.duration ?? 300
    const id = roundIdOf(pool, duration, Math.floor(this.time / duration))
    const up = o.up ?? 2n * 10n ** 17n
    const down = o.down ?? 2n * 10n ** 17n
    this.rounds.set(id, {
      rawUp: up, rawDown: down,
      minBank: o.minBank ?? 2n * 10n ** 16n,
      costAllowance: o.allowance ?? 10n ** 15n,
      strikeFixed: false, outcome: 0, reason: 0,
    })
    this.emit('RoundOpened', id)
    if (up) this.emit('Bet', id)
    if (down) this.emit('Bet', id)
    return id
  }

  warp(t: number) { this.time = t; this.block += 10n }
  private emit(eventName: 'RoundOpened' | 'Bet' | 'StrikeFixed' | 'RoundSettled', roundId: bigint, extra: { outcome?: number; reason?: number } = {}) {
    this.events.push({ eventName, roundId, blockNumber: this.block, logIndex: this.events.length, ...extra })
    this.block += 1n
  }
  private emitPool(eventName: 'PoolListed' | 'PoolDelisted', pool: Address) {
    this.events.push({ kind: 'pool', eventName, pool, blockNumber: this.block, logIndex: this.events.length })
    this.block += 1n
  }
  /** Drop the RoundSettled event of a round, as a discovery that has not seen it yet. */
  hideSettled(id: bigint) {
    this.events = this.events.filter((l) => !(l.kind !== 'pool' && l.roundId === id && l.eventName === 'RoundSettled'))
  }

  private kindOf(call: WriteCall): Kind {
    if (call.fn === 'withdrawFees') return 'withdrawFees'
    if (call.fn === 'delistIfBelowGate') return 'delist'
    if (call.fn === 'settle' && this.time >= this.times(call.roundId).settleAt + GRACE) return 'grace'
    return call.fn
  }

  /** PoolRounds, in the contract's order of checks. */
  private revertOf(call: WriteCall): string | null {
    if (call.fn === 'withdrawFees') return this.feesAccruedWei === 0n ? 'NothingToWithdraw' : null
    if (call.fn === 'delistIfBelowGate') {
      const p = this.pools.get(call.pool.toLowerCase())
      if (!p || !p.listed) return 'PoolNotListed'
      return p.below ? null : 'PoolAboveGate'
    }
    const t = this.times(call.roundId)
    const r = this.rounds.get(call.roundId)
    if (this.time < (call.fn === 'fixStrike' ? t.strikeEnd : t.settleAt)) return 'NotDue'
    if (!r || !isActive(r)) return 'NotActivated'
    if (r.outcome !== 0) return 'AlreadySettled'
    if (call.fn === 'fixStrike' && r.strikeFixed) return 'StrikeAlreadyFixed'
    if (this.time >= t.settleAt + GRACE) return null
    if (this.unpriceable.has(call.roundId)) return 'PriceUnavailableNow'
    return null
  }

  /** What the call does at this.time: the ring and the depth rule included. */
  private apply(call: WriteCall): ReceiptEvent[] {
    if (call.fn === 'withdrawFees') {
      const amount = this.feesAccruedWei
      this.feesAccruedWei = 0n
      return [{ eventName: 'FeesWithdrawn', amount }]
    }
    if (call.fn === 'delistIfBelowGate') {
      this.pools.get(call.pool.toLowerCase())!.listed = false
      this.emitPool('PoolDelisted', call.pool)
      return [{ eventName: 'PoolBelowGate', pool: call.pool, depth: 10n ** 18n, cardinality: BigInt(this.ring) }]
    }
    const id = call.roundId
    const r = this.rounds.get(id)!
    const t = this.times(id)
    const { duration } = decodeRoundId(id)
    const memory = this.ring - 1
    const busy = !this.quiet.has(id)
    const settleAs = (outcome: number, reason: number): ReceiptEvent[] => {
      r.outcome = outcome
      r.reason = reason
      r.settledAt = this.time
      const bank = 2n * (r.rawUp < r.rawDown ? r.rawUp : r.rawDown)
      this.feesAccruedWei += (bank * (outcome === 1 ? 180n : 90n)) / 10_000n
      this.emit('RoundSettled', id, { outcome, reason })
      return [{ eventName: 'RoundSettled', roundId: id, outcome, reason }]
    }
    if (this.time >= t.settleAt + GRACE) return settleAs(4, 3)
    if (call.fn === 'fixStrike') {
      if (busy && this.time > t.strikeStart + memory) return settleAs(4, 1) // the ring lost the strike window
      if (this.thinWindow.has(id)) return settleAs(4, 4) // the strike window was too thin for the bank
      r.strikeFixed = true
      r.fixedAt = this.time
      this.emit('StrikeFixed', id)
      return [{ eventName: 'StrikeFixed', roundId: id }]
    }
    const readsFrom = r.strikeFixed ? t.settleAt - exitWindow(Number(duration)) : t.strikeStart
    if (busy && this.time > readsFrom + memory) return settleAs(4, 1)
    if (this.thinWindow.has(id)) return settleAs(4, 4)
    return settleAs(1, 0)
  }

  /** Anyone (a player) calling settle: permissionless. */
  settleAsAnyone(id: bigint): string | null {
    const err = this.revertOf({ fn: 'settle', roundId: id })
    if (err) return err
    this.apply({ fn: 'settle', roundId: id })
    return null
  }

  // ── RoundsChain ──
  async latest() {
    if (this.failLatest > 0) {
      this.failLatest--
      throw new Error('fetch failed: ECONNRESET')
    }
    return { number: this.block, timestamp: this.time }
  }
  async params() { return { settleGrace: GRACE } }
  async logs(from: bigint, to: bigint) { return this.events.filter((l) => l.blockNumber >= from && l.blockNumber <= to) }
  async feesAccrued() { return this.feesAccruedWei }
  async keeperBalance() { return 5n * ETH }
  async gateDepth() { return 50n * ETH }
  async wethDepth(pool: Address) { return this.pools.get(pool.toLowerCase())?.below ? ETH : 100n * ETH }

  async roundTimes(id: bigint): Promise<RawTimes> {
    this.timesReads++
    if (this.garbageTimes) return { ...this.rawTimes(id), strikeEnd: 1n }
    return this.rawTimes(id)
  }

  async keeperDeadlines(id: bigint): Promise<RawDeadlines> {
    this.deadlineReads++
    const d = this.deadlines(id)
    return { fixStrikeBy: BigInt(d.fixStrikeBy), settleBy: BigInt(d.settleBy) }
  }

  async roundView(id: bigint): Promise<RawRoundView> {
    this.views++
    const stale = this.staleView.get(id)
    if (stale) return stale
    return this.rawView(id)
  }

  rawView(id: bigint): RawRoundView {
    const r = this.rounds.get(id)!
    const t = this.times(id)
    const { pool, duration, index } = decodeRoundId(id)
    const bookClosed = this.time >= t.closeAt
    return {
      pool: this.wrongPool ? getAddress('0x000000000000000000000000000000000000dead') : pool,
      duration, index,
      times: this.rawTimes(id),
      committed: r.rawUp + r.rawDown, rawUp: r.rawUp, rawDown: r.rawDown, acceptedUp: 0n, acceptedDown: 0n, bank: 0n,
      minBank: r.minBank, costAllowance: r.costAllowance,
      bookClosed, activated: bookClosed && isActive(r), strikeFixed: r.strikeFixed, outcome: r.outcome,
      entryTick: 0, exitTick: 0,
    }
  }

  async simulate(call: WriteCall): Promise<SimResult> {
    if (call.fn === 'delistIfBelowGate') this.poolSims.push(call.pool)
    else this.sims.push(call)
    const err = this.revertOf(call)
    return err ? { ok: false, error: err } : { ok: true, estimate: this.gasUsed[this.kindOf(call)] }
  }

  async send(call: WriteCall, gas: bigint, fees: Fees): Promise<Hex> {
    const e = this.sendErrors.shift()
    if (e) throw e
    const hash = `0x${(++this.nonce).toString(16).padStart(64, '0')}` as Hex
    this.pending.set(hash, { call, gas, fees })
    this.sent.push({ call, gas, fees, at: this.time })
    return hash
  }

  async waitForReceipt(hash: Hex): Promise<RoundsReceipt> {
    if (this.receiptTimeouts > 0) {
      this.receiptTimeouts--
      throw Object.assign(new Error('Timed out while waiting for transaction'), { name: 'WaitForTransactionReceiptTimeoutError' })
    }
    const p = this.pending.get(hash)!
    this.pending.delete(hash)
    this.block += 1n
    const kind = this.kindOf(p.call)
    const price = p.fees.maxFeePerGas < this.baseFee + p.fees.maxPriorityFeePerGas ? p.fees.maxFeePerGas : this.baseFee + p.fees.maxPriorityFeePerGas
    const err = this.revertOf(p.call)
    if (err || p.gas < (this.requiredGas.get(kind) ?? 0n)) {
      return { status: 'reverted', gasUsed: err ? 30_000n : p.gas, effectiveGasPrice: price, blockNumber: this.block, events: [] }
    }
    const events = this.apply(p.call)
    return { status: 'success', gasUsed: this.gasUsed[kind], effectiveGasPrice: price, blockNumber: this.block, events }
  }
}

const pool = (i: number) => getAddress(`0x${i.toString(16).padStart(2, '0').repeat(20)}`)
const P1 = pool(0x11)
const P2 = pool(0x22)
const P3 = pool(0x33)
const P4 = pool(0x44)
const P5 = pool(0x55)

function config(over: Partial<RoundsConfig> = {}): RoundsConfig {
  return {
    deployment: { address: getAddress('0x00000000000000000000000000000000000000c0'), startBlock: 0n },
    intervalMs: 10_000,
    logChunk: 100_000n,
    logOverlap: 0n,
    lookbackBlocks: 0n,
    maxChunksPerTick: 20,
    confirmations: 0n,
    graceReserveBps: 2_000n,
    l1ReserveWei: 0n,
    feesWithdrawMinWei: null,
    receiptTimeoutMs: 1_000,
    maxTxPerTick: 20,
    poolCheckSec: 300,
    delistDailyBudgetWei: 10n ** 15n,
    ...over,
  }
}

class Guard implements RoundsGasGuard {
  checks: string[] = []
  records: Array<{ cost: bigint; priority: string }> = []
  routineSkip: string | null = null
  async check(p: 'critical' | 'routine') { this.checks.push(p); return p === 'routine' ? this.routineSkip : null }
  async record(r: { gasUsed: bigint; effectiveGasPrice: bigint }, p: 'critical' | 'routine') {
    this.records.push({ cost: r.gasUsed * r.effectiveGasPrice, priority: p })
  }
}

/** sendKeeperTx's contract with its caller: `send` gets the quoted fees. A fixed quote here. */
const sendAt = (maxFeePerGas: bigint, maxPriorityFeePerGas = 0n): SendTx => async (send) => send({ maxFeePerGas, maxPriorityFeePerGas })

/** The escalation part of sendKeeperTx: a stuck nonce is retried at 1.25x the fee. */
const escalatingSend = (base: Fees): SendTx => async (send) => {
  for (let level = 0; ; level++) {
    try {
      return await send(escalate(base, level))
    } catch (err) {
      if (!isStuckNonceError(err) || level >= 3) throw err
    }
  }
}

let chain: FakePoolRounds
let store: MemoryRoundsStore
let guard: Guard
let wall: number
const quiet = { info: () => {}, warn: () => {}, error: () => {} }

function keeper(over: Partial<RoundsConfig> = {}, sendTx: SendTx = sendAt(2n * GWEI)) {
  return createRoundsKeeper({ chain, store, sendTx, gasGuard: guard, config: config(over), nowMs: () => wall, log: quiet })
}

const kindsSent = () => chain.sent.map((s) => s.call.fn)
const idsSent = () => chain.sent.map((s) => (s.call as { roundId: bigint }).roundId)
const planOf = (rep: TickReport, id: bigint) => rep.plans.find((p) => p.roundId === id)?.plan
/** The deadlines keeperDeadlines reports for a round: from the fake contract, as the keeper reads them. */
const FIX_BY = (id: bigint) => chain.deadlines(id).fixStrikeBy
const SETTLE_BY = (id: bigint) => chain.deadlines(id).settleBy
/**
 * A contract with a smaller ring states tighter deadlines (strikeEnd + 119,
 * settleAt + 359): fixStrike's deadline then falls before settleAt, which is
 * what the tests of a late fixStrike need. The keeper just follows.
 */
const tight = () => { chain.ring = 420 }

beforeEach(() => {
  chain = new FakePoolRounds()
  store = new MemoryRoundsStore()
  guard = new Guard()
  wall = 1_000_000
})

describe('a round from first bet to settlement', () => {
  it('does nothing while players bet, drops nothing that activated, fixes the strike at strikeEnd and settles at settleAt', async () => {
    const id = chain.open(P1)
    const t = chain.times(id)
    const k = keeper()

    let rep = await k.tick()
    expect(planOf(rep, id)).toMatchObject({ kind: 'wait', phase: 'collecting' })
    expect(await store.openRounds()).toEqual([id])
    expect(chain.views).toBe(0) // before closeAt nothing can be due: only roundTimes, once

    chain.warp(t.closeAt)
    rep = await k.tick()
    expect(planOf(rep, id)).toEqual({ kind: 'wait', until: t.strikeEnd, phase: 'strike-pending' })
    chain.warp(t.strikeStart + 100)
    await k.tick()
    expect(chain.views).toBe(1) // not re-read through the pause and the strike window

    chain.warp(t.strikeEnd)
    rep = await k.tick()
    expect(kindsSent()).toEqual(['fixStrike'])
    expect(chain.sent[0]).toMatchObject({ gas: 150_000n, fees: { maxFeePerGas: 2n * GWEI } }) // first try, 599 s left: the plain quote
    expect(planOf(rep, id)).toEqual({ kind: 'wait', until: t.settleAt, phase: 'settle-pending' })

    chain.warp(t.settleAt + 2)
    rep = await k.tick()
    expect(kindsSent()).toEqual(['fixStrike', 'settle'])
    expect(chain.sent[1].gas).toBe(260_000n)
    expect(rep.dropped).toEqual([{ roundId: id, why: 'settled' }])
    expect(chain.rounds.get(id)).toMatchObject({ outcome: 1, reason: 0 })

    // What it cost, from the receipts: 80 000 + 156 000 gas at 1 gwei.
    expect(await store.getSpent(id)).toBe(236_000n * GWEI)
    expect(guard.records).toEqual([{ cost: 80_000n * GWEI, priority: 'critical' }, { cost: 156_000n * GWEI, priority: 'critical' }])
    expect(chain.timesReads).toBe(1)
    expect(chain.deadlineReads).toBe(1)
  })
})

describe('deadlines come from keeperDeadlines', () => {
  it('plans a call against the deadline the contract states, not one of its own', async () => {
    const id = chain.open(P1)
    const t = chain.times(id)
    chain.unpriceable.add(id)
    const k = keeper()
    // 200 s after strikeEnd: past what a ring of 420 would allow (119 s), well
    // inside what this contract states (599 s). Still inside: whole allowance,
    // no pause, no parking.
    chain.warp(t.strikeEnd + 200)
    const rep = await k.tick()
    expect(planOf(rep, id)).toMatchObject({ kind: 'act', action: 'fixStrike', deadlineAt: FIX_BY(id), pastDeadline: false, capWei: 10n ** 15n })
    expect(FIX_BY(id) - t.strikeEnd).toBe(599)
    expect(SETTLE_BY(id) - t.settleAt).toBe(839)
    expect(rep.snapshot.deadlines[0]).toMatchObject({ deadlineAt: FIX_BY(id) })
    expect(chain.deadlineReads).toBe(1)
  })

  it('reads the settle deadline of a 900 s round from the contract too (settleAt + 719)', async () => {
    const id = chain.open(P1, { duration: 900 })
    const t = chain.times(id)
    chain.quiet.add(id)
    const k = keeper()
    chain.warp(t.strikeEnd)
    await k.tick()
    chain.warp(t.settleAt)
    chain.unpriceable.add(id)
    const rep = await k.tick()
    expect(planOf(rep, id)).toMatchObject({ kind: 'act', action: 'settle', deadlineAt: t.settleAt + 719 })
  })
})

/**
 * No paid work exists for a round that did not activate: both keeper calls
 * revert NotActivated on it, and the players take their stakes back with
 * claim(). v3 knows it at closeAt; the keeper must not even dry-run them.
 */
describe('rounds that did not activate', () => {
  it('are let go at closeAt without a single dry run or transaction, and stay gone', async () => {
    const oneSided = chain.open(P1, { up: 3n * 10n ** 17n, down: 0n })
    const thin = chain.open(P2, { up: 10n ** 15n, down: 10n ** 15n })
    // Bank 0.4 ETH, but the 1% it keeps (0.0036) does not cover twice an allowance of 0.002.
    const dear = chain.open(P3, { allowance: 2n * 10n ** 15n })
    const t = chain.times(oneSided)
    const k = keeper({ logOverlap: 1_000_000n }) // re-read every event on every tick

    chain.warp(t.closeAt)
    const rep = await k.tick()
    expect(new Set(rep.dropped.map((d) => d.roundId))).toEqual(new Set([oneSided, thin, dear]))
    expect(rep.dropped.every((d) => d.why === 'not-activated')).toBe(true)

    for (const at of [t.strikeEnd, t.settleAt, t.settleAt + GRACE, t.settleAt + 3 * GRACE]) {
      chain.warp(at)
      await k.tick()
    }
    expect(chain.sims).toEqual([])
    expect(chain.sent).toEqual([])
    expect(await store.openRounds()).toEqual([])
    expect(store.spent.size).toBe(0)
  })
})

describe('retries', () => {
  it('retries a dry run that cannot price the round every tick, for free, and settles from the 24 h branch at the end', async () => {
    const id = chain.open(P1)
    chain.quiet.add(id)
    const t = chain.times(id)
    const k = keeper()
    chain.warp(t.strikeEnd)
    await k.tick() // fixStrike
    chain.unpriceable.add(id)
    for (let i = 0; i < 5; i++) {
      chain.warp(t.settleAt + i * 10)
      await k.tick()
    }
    expect(kindsSent()).toEqual(['fixStrike'])
    expect(chain.sims.filter((c) => c.fn === 'settle')).toHaveLength(5)
    const spentBefore = await store.getSpent(id)

    chain.warp(t.settleAt + GRACE)
    const rep = await k.tick()
    expect(kindsSent()).toEqual(['fixStrike', 'settle'])
    expect(chain.sent[1].gas).toBe(100_000n) // the 24 h floor, small enough for the reserve
    expect(rep.dropped).toEqual([{ roundId: id, why: 'settled' }])
    expect(chain.rounds.get(id)).toMatchObject({ outcome: 4, reason: 3 })
    expect(await store.getSpent(id)).toBe(spentBefore + 54_000n * GWEI)
  })

  it('raises the gas limit after a revert out of gas, and bids double on the retry', async () => {
    const id = chain.open(P1, { allowance: 10n ** 16n, up: 2n * ETH, down: 2n * ETH })
    const t = chain.times(id)
    const k = keeper()
    chain.requiredGas.set('fixStrike', 200_000n)
    chain.warp(t.strikeEnd)
    await k.tick()
    chain.warp(t.strikeEnd + 10)
    await k.tick()
    expect(chain.sent.map((s) => [s.gas, s.fees.maxFeePerGas])).toEqual([[150_000n, 2n * GWEI], [225_000n, 4n * GWEI]])
    expect(chain.rounds.get(id)!.strikeFixed).toBe(true)
    // Both are paid for, the revert included: all 150 000 gas of it. The doubled
    // bid is a cap, not a price: charged base + tip = 1 gwei.
    expect(await store.getSpent(id)).toBe((150_000n + 80_000n) * GWEI)
  })

  it('does not pause a call inside its deadline after reverts; pauses it once the deadline has passed', async () => {
    tight()
    const id = chain.open(P1, { allowance: 10n ** 16n, up: 2n * ETH, down: 2n * ETH })
    chain.quiet.add(id)
    const t = chain.times(id)
    const k = keeper()
    chain.requiredGas.set('fixStrike', 10_000_000n)
    for (let i = 0; i < 4; i++) {
      chain.warp(t.strikeEnd + i * 10)
      await k.tick()
    }
    expect(chain.sent.map((s) => s.gas)).toEqual([150_000n, 225_000n, 337_500n, 450_000n]) // 3x cap
    // Past the deadline: the pause earned by those reverts now holds.
    chain.warp(FIX_BY(id) + 1)
    const rep = await k.tick()
    expect(chain.sent).toHaveLength(4)
    expect(planOf(rep, id)).toMatchObject({ kind: 'paused', action: 'fixStrike' })
    wall += 5 * 60_000
    chain.warp(FIX_BY(id) + 20)
    await k.tick()
    expect(chain.sent).toHaveLength(5)
  })

  it('does not carry a failure streak from fixStrike over to settle', async () => {
    const id = chain.open(P1, { allowance: 10n ** 16n, up: 2n * ETH, down: 2n * ETH })
    chain.quiet.add(id)
    const t = chain.times(id)
    const k = keeper()
    chain.requiredGas.set('fixStrike', 10_000_000n)
    chain.warp(t.strikeEnd)
    await k.tick()
    await k.tick()
    chain.warp(t.settleAt)
    await k.tick()
    const last = chain.sent[chain.sent.length - 1]
    expect(last).toMatchObject({ call: { fn: 'settle' }, gas: 260_000n, fees: { maxFeePerGas: 2n * GWEI } })
    expect(chain.rounds.get(id)!.outcome).toBe(1)
  })

  it('keeps dry-running a call that fails for an unknown reason while its deadline lasts, parks it only after', async () => {
    tight()
    const id = chain.open(P1)
    const t = chain.times(id)
    const k = keeper()
    let tries = 0
    const sim = chain.simulate.bind(chain)
    chain.simulate = async (c) => {
      if (c.fn === 'delistIfBelowGate') return sim(c) // the gate check: not what this test counts
      tries++
      return { ok: false, error: 'SafeERC20FailedOperation' }
    }
    for (let s = 0; s <= 110; s += 10) {
      chain.warp(t.strikeEnd + s)
      await k.tick()
    }
    expect(tries).toBe(12) // every tick up to strikeEnd + 119
    for (let s = 120; s <= 290; s += 10) { // settleAt (+300) would make settle due: another call
      chain.warp(t.strikeEnd + s)
      await k.tick()
    }
    expect(tries).toBe(12 + 5) // then five more, and parked
    expect(chain.sent).toEqual([])
    expect(id).toBeDefined()
  })
})

/**
 * The spending rule: what the keeper spends on a round, reverts included,
 * never goes above that round's costAllowance. Inside its hard deadline a call
 * may use all of it and is never held back for price; past the deadline it
 * stops at allowance x (1 - reserve), so the 24 h settle can still be paid for.
 */
describe('per-round budget', () => {
  const ALLOWANCE = 10n ** 15n // 1 000 000 gas at 1 gwei
  const CAP = (ALLOWANCE * 8n) / 10n

  it('retries every tick inside the deadline, holds back past it, and releases the round from the reserve at 24 h', async () => {
    tight()
    const id = chain.open(P1, { allowance: ALLOWANCE })
    chain.quiet.add(id)
    const t = chain.times(id)
    const k = keeper()
    chain.requiredGas.set('fixStrike', 10_000_000n) // never enough

    chain.warp(t.strikeEnd)
    await k.tick()
    expect(chain.sent.map((s) => s.gas)).toEqual([150_000n])
    expect(await store.getSpent(id)).toBe(150_000n * GWEI)

    // The retry wants 225 000 gas at a doubled 4 gwei; the room left (8.5e14)
    // covers 3.78 gwei, so that is the bid: cut to fit, not refused.
    chain.warp(t.strikeEnd + 10)
    await k.tick()
    expect(chain.sent[1]).toMatchObject({ gas: 225_000n, fees: { maxFeePerGas: (ALLOWANCE - 150_000n * GWEI) / 225_000n } })
    expect(await store.getSpent(id)).toBe(375_000n * GWEI)

    // 337 500 gas: room 6.25e14 covers 1.85 gwei, below the 2 gwei quote. Not
    // sent, and tried again every tick while the deadline lasts.
    const sims = chain.sims.length
    for (const s of [20, 30, 40]) {
      chain.warp(t.strikeEnd + s)
      const rep = await k.tick()
      expect(rep.actions[0].outcome.kind).toBe('over-budget')
    }
    expect(chain.sims.length).toBe(sims + 3)

    // Past the deadline the cap drops to 8e14; nothing more fits, and the round
    // waits for the 24 h branch without being dry-run again.
    chain.warp(FIX_BY(id) + 1)
    let rep = await k.tick()
    const after = chain.sims.length
    for (const dt of [600, 3600, GRACE - 1]) {
      chain.warp(t.settleAt + dt)
      rep = await k.tick()
    }
    expect(chain.sims.length).toBe(after)
    expect(planOf(rep, id)).toMatchObject({ kind: 'over-budget', action: 'settle' })
    expect(rep.snapshot.overBudget).toBe(1)

    chain.warp(t.settleAt + GRACE)
    rep = await k.tick()
    expect(chain.sent.map((s) => s.gas)).toEqual([150_000n, 225_000n, 100_000n])
    expect(chain.rounds.get(id)).toMatchObject({ outcome: 4, reason: 3 })
    const total = await store.getSpent(id)
    expect(total).toBe((375_000n + 54_000n) * GWEI)
    expect(total).toBeLessThanOrEqual(ALLOWANCE)
  })

  it('never lets spend pass the allowance, whatever the reverts cost', async () => {
    const id = chain.open(P1, { allowance: ALLOWANCE })
    chain.quiet.add(id)
    const t = chain.times(id)
    chain.baseFee = 2n * GWEI // every revert charged the whole quote
    for (const k of ['fixStrike', 'settle', 'grace'] as Kind[]) chain.requiredGas.set(k, 10_000_000n)
    const k = keeper()
    const ats = [t.strikeEnd, t.strikeEnd + 10, t.strikeEnd + 20, t.settleAt, t.settleAt + 10, FIX_BY(id) + 5, SETTLE_BY(id) + 5]
    for (const at of ats) {
      chain.warp(at)
      wall += 400_000
      await k.tick()
      expect(await store.getSpent(id)).toBeLessThanOrEqual(ALLOWANCE)
    }
    for (let i = 0; i < 6; i++) {
      chain.warp(t.settleAt + GRACE + i * 10)
      wall += 700_000
      await k.tick()
      expect(await store.getSpent(id)).toBeLessThanOrEqual(ALLOWANCE)
    }
    expect(chain.rounds.get(id)!.outcome).toBe(0)
    expect(chain.sent.length).toBeGreaterThan(2)
  })

  it('refuses only when even the plain quote does not fit', async () => {
    const id = chain.open(P1, { allowance: ALLOWANCE })
    const t = chain.times(id)
    // 150 000 gas x 7 gwei = 1.05e15: over the allowance before anything is spent.
    const k = keeper({}, sendAt(7n * GWEI))
    chain.warp(t.strikeEnd)
    const rep = await k.tick()
    expect(chain.sent).toEqual([])
    expect(rep.actions[0].outcome.kind).toBe('over-budget')
    expect(await store.getSpent(id)).toBe(0n)
  })

  it('does not wait for gas to get cheaper: a 30x spike is paid at once if the allowance covers it', async () => {
    const id = chain.open(P1, { allowance: 10n ** 16n, up: 2n * ETH, down: 2n * ETH })
    const t = chain.times(id)
    chain.baseFee = 30n * GWEI
    const k = keeper({}, sendAt(36n * GWEI))
    chain.warp(t.strikeEnd)
    await k.tick()
    expect(chain.sent).toMatchObject([{ call: { fn: 'fixStrike' }, fees: { maxFeePerGas: 36n * GWEI } }])
    expect(chain.rounds.get(id)!.strikeFixed).toBe(true)
    expect(guard.checks).toContain('critical') // logged by the gas guard, not blocked by it
  })

  it('releases the reservation of a send that was rejected, and checks the escalated retry', async () => {
    const id = chain.open(P1, { allowance: ALLOWANCE })
    const t = chain.times(id)
    chain.sendErrors.push(new Error('replacement transaction underpriced'))
    const k = keeper({}, escalatingSend({ maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: 0n }))
    chain.warp(t.strikeEnd)
    await k.tick()
    expect(chain.sent).toHaveLength(1)
    expect(chain.sent[0].fees.maxFeePerGas).toBe(2_500_000_000n)
    // Only the receipt: the rejected attempt's reservation was given back.
    expect(await store.getSpent(id)).toBe(80_000n * GWEI)
  })

  it('keeps the reservation when it cannot tell whether the transaction went out, and bills the late receipt once', async () => {
    const id = chain.open(P1, { allowance: ALLOWANCE })
    const t = chain.times(id)
    chain.sendErrors.push(Object.assign(new Error('The request took too long to respond.'), { name: 'TimeoutError' }))
    const k = keeper()
    chain.warp(t.strikeEnd)
    let rep = await k.tick()
    expect(rep.actions[0].outcome.kind).toBe('send-failed')
    expect(await store.getSpent(id)).toBe(150_000n * 2n * GWEI) // limit x bid, booked

    // A receipt that does not come keeps its reservation too, and the next tick
    // asks for it before anything else: it has landed, billed at its real cost.
    const id2 = chain.open(P2, { allowance: ALLOWANCE })
    chain.receiptTimeouts = 1
    chain.warp(chain.times(id2).strikeEnd)
    rep = await k.tick()
    expect(rep.actions.find((a) => a.roundId === id2)?.outcome.kind).toBe('pending')
    expect(await store.getSpent(id2)).toBe(150_000n * 2n * GWEI)
    const sentBefore = chain.sent.filter((s) => (s.call as { roundId: bigint }).roundId === id2).length
    chain.warp(chain.times(id2).strikeEnd + 10)
    rep = await k.tick()
    expect(rep.actions.find((a) => a.roundId === id2)?.outcome).toMatchObject({ kind: 'sent', status: 'success' })
    expect(chain.sent.filter((s) => (s.call as { roundId: bigint }).roundId === id2).length).toBe(sentBefore)
    expect(await store.getSpent(id2)).toBe(80_000n * GWEI)
  })

  it('gives up on a missing receipt after 30 s when a deadline is at stake, and sends again', async () => {
    const id = chain.open(P1, { allowance: 10n ** 16n, up: 2n * ETH, down: 2n * ETH })
    const t = chain.times(id)
    const k = keeper()
    chain.warp(t.strikeEnd)
    chain.receiptTimeouts = 3 // the first wait and two look-ups find nothing
    await k.tick()
    wall += 10_000
    await k.tick()
    expect(chain.sent).toHaveLength(1)
    wall += 25_000 // 35 s since the send
    chain.warp(t.strikeEnd + 35)
    await k.tick()
    expect(chain.sent).toHaveLength(2) // taken as lost; the fake still held the first, so the second reverts harmlessly
  })

  it('leaves a round to its players once even the 24 h settle does not fit', async () => {
    const id = chain.open(P1, { allowance: ALLOWANCE })
    const t = chain.times(id)
    await store.addSpent(id, ALLOWANCE)
    const k = keeper()
    chain.warp(t.settleAt + GRACE)
    const rep = await k.tick()
    expect(rep.dropped).toEqual([{ roundId: id, why: 'allowance-exhausted' }])
    expect(chain.sims).toEqual([])
    expect(chain.sent).toEqual([])
  })

  it('survives a restart: a new process reads the spend, not zero', async () => {
    const id = chain.open(P1, { allowance: ALLOWANCE })
    const t = chain.times(id)
    chain.warp(t.strikeEnd)
    // An earlier process spent 9e14 on this round: the 1e14 left does not
    // cover fixStrike even at the plain quote (150 000 x 2 gwei = 3e14).
    await store.addSpent(id, 9n * 10n ** 14n)
    const rep = await keeper().tick() // a fresh process, the same store: what Redis hands back
    expect(chain.sent).toEqual([])
    expect(rep.actions[0].outcome.kind).toBe('over-budget')

    // Counter-check: had the spend been forgotten, the same tick would have sent.
    store = new MemoryRoundsStore()
    await keeper().tick()
    expect(kindsSent()).toEqual(['fixStrike'])
  })
})

describe('the order of the queue', () => {
  it('sends fixStrike and settle by earliest deadline, first attempts before retries, then late calls, then the 24 h settle', async () => {
    tight()
    const S = 5_966_700 * 300 // a strikeEnd of a 300 s round
    chain.time = S - 900
    const fresh = chain.open(P1) // fixStrike due at S, deadline S + 119
    chain.time = S - 1200
    const settle = chain.open(P2) // settleAt S, strike fixed: settle deadline S + 359
    const late = chain.open(P3) // same window, strike never fixed: its deadline S - 181 is gone
    chain.time = S - 720
    const retry = chain.open(P4, { duration: 90 }) // a 90 s round: fixStrike due at S - 30, deadline S + 89, settleAt S + 60
    for (const id of [fresh, settle, late, retry]) chain.quiet.add(id)
    chain.rounds.get(settle)!.strikeFixed = true
    const k = keeper()

    // One tick earlier `retry` (and `late`) fail their first dry run.
    chain.unpriceable.add(retry)
    chain.unpriceable.add(late)
    chain.warp(S - 20)
    wall = (S - 20) * 1000
    await k.tick()
    expect(chain.sent).toEqual([])
    chain.unpriceable.clear()
    chain.time = S - 2 * GRACE
    const grace = chain.open(P5) // its 24 h settle is due

    chain.warp(S + 10)
    wall = (S + 10) * 1000
    await k.tick()
    // `retry` has the earliest deadline (79 s left) but it is a retry: first
    // attempts of other rounds go first, then retries, then late calls, then 24 h.
    expect(idsSent()).toEqual([fresh, settle, retry, late, grace])
    const bid = (id: bigint) => chain.sent.find((x) => (x.call as { roundId: bigint }).roundId === id)!.fees.maxFeePerGas
    expect(bid(fresh)).toBe(2n * GWEI) // 109 s left, first attempt: the quote
    expect(bid(retry)).toBe(4n * GWEI) // a retry: double
    expect(bid(late)).toBe(2n * GWEI) // past its deadline: no premium
  })

  it('caps transactions per tick and carries the rest to the next tick', async () => {
    const ids = [P1, P2, P3, P4, P5].map((p) => chain.open(p))
    const k = keeper({ maxTxPerTick: 3 })
    chain.warp(chain.times(ids[0]).strikeEnd)
    await k.tick()
    expect(chain.sent).toHaveLength(3)
    chain.warp(chain.times(ids[0]).strikeEnd + 10)
    await k.tick()
    expect(chain.sent).toHaveLength(5)
  })
})

describe('state comes from receipts and the chain, not from assumptions', () => {
  it('does not fix a strike twice when a lagging replica still says it is not fixed', async () => {
    const id = chain.open(P1)
    const t = chain.times(id)
    const k = keeper()
    chain.warp(t.strikeEnd)
    await k.tick()
    chain.staleView.set(id, { ...chain.rawView(id), strikeFixed: false })
    for (let i = 1; i <= 4; i++) {
      chain.warp(t.strikeEnd + i * 10)
      await k.tick()
    }
    expect(kindsSent()).toEqual(['fixStrike'])
  })

  it('lets go of a round somebody else settled, without paying anything', async () => {
    const a = chain.open(P1)
    const b = chain.open(P2)
    for (const id of [a, b]) chain.quiet.add(id)
    const t = chain.times(a)
    const k = keeper()
    chain.warp(t.closeAt)
    await k.tick()
    chain.warp(t.settleAt)
    expect(chain.settleAsAnyone(a)).toBeNull()
    expect(chain.settleAsAnyone(b)).toBeNull()
    // a's RoundSettled is not visible to discovery yet, and its view is read from a lagging replica.
    chain.hideSettled(a)
    chain.staleView.set(a, { ...chain.rawView(a), outcome: 0 })
    const rep = await k.tick()
    expect(chain.sent).toEqual([])
    expect(await store.openRounds()).toEqual([])
    expect(rep.dropped).toEqual([{ roundId: a, why: 'AlreadySettled' }]) // b left through its RoundSettled event
  })

  it('keeps working on the rounds it knows when getLogs fails', async () => {
    const id = chain.open(P1)
    const k = keeper()
    await k.tick()
    chain.logs = async () => { throw new Error('HTTP 429 Too Many Requests') }
    chain.warp(chain.times(id).strikeEnd)
    const rep = await k.tick()
    expect(kindsSent()).toEqual(['fixStrike'])
    expect(rep.snapshot.caughtUp).toBe(false)
    expect(rep.snapshot.lastError).toMatch(/discovery: HTTP 429/)
  })

  it('refuses to act on a contract whose roundView does not decode to the round asked about', async () => {
    const id = chain.open(P1)
    chain.wrongPool = true
    chain.warp(chain.times(id).strikeEnd)
    const rep = await keeper().tick()
    expect(chain.sims).toEqual([])
    expect(rep.snapshot.abiMismatch).toBe(true)
    expect(await store.openRounds()).toEqual([id])
  })

  it('refuses to act when roundTimes does not decode to deadlines in order', async () => {
    const id = chain.open(P1)
    chain.garbageTimes = true
    chain.warp(chain.times(id).strikeEnd)
    const rep = await keeper().tick()
    expect(chain.sims).toEqual([])
    expect(rep.snapshot.lastError).toMatch(/^roundTimes\(/)
  })

  it('reads roundTimes once per round, not once per tick', async () => {
    const a = chain.open(P1)
    chain.open(P2)
    const k = keeper()
    const t = chain.times(a)
    for (const at of [t.openAt + 10, t.closeAt, t.strikeStart, t.strikeEnd, t.strikeEnd + 10]) {
      chain.warp(at)
      await k.tick()
    }
    expect(chain.timesReads).toBe(2)
  })
})

describe('fees', () => {
  it('withdraws past the threshold as routine work, after the rounds, billed to no round', async () => {
    const k = keeper({ feesWithdrawMinWei: 10n ** 15n })
    chain.feesAccruedWei = 5n * 10n ** 14n
    await k.tick()
    expect(chain.sims).toEqual([])

    chain.feesAccruedWei = 2n * 10n ** 15n
    guard.routineSkip = 'fee 5 gwei > ceiling 4 gwei'
    let rep = await k.tick()
    expect(rep.actions).toEqual([{ roundId: null, action: 'withdrawFees', outcome: { kind: 'skipped', why: 'fee 5 gwei > ceiling 4 gwei' } }])

    guard.routineSkip = null
    const id = chain.open(P1)
    chain.warp(chain.times(id).strikeEnd)
    rep = await k.tick()
    expect(kindsSent()).toEqual(['fixStrike', 'withdrawFees']) // the round first
    expect(chain.feesAccruedWei).toBe(0n)
    expect(guard.records.filter((r) => r.priority === 'routine')).toEqual([{ cost: 73_000n * GWEI, priority: 'routine' }])
  })

  it('does nothing about fees when switched off', async () => {
    chain.feesAccruedWei = 10n ** 18n
    await keeper({ feesWithdrawMinWei: null }).tick()
    expect(chain.sent).toEqual([])
    expect(guard.checks).toEqual([])
  })
})

/**
 * The hard deadlines, on an artificial clock. The keeper ticks every 10 s (the
 * slowest poll ROUNDS_INTERVAL_MS allows) from a phase that lands the first
 * tick after strikeEnd as late as it can; the fake pool writes an observation
 * every second, so a call past the deadline keeperDeadlines reports (strikeEnd
 * + 599 and settleAt + 839 here) turns the round into REFUND. Each case checks when the calls
 * were mined against those deadlines, and the outcome.
 */
describe('hard deadlines on an artificial clock', () => {
  const STEP = 10

  /** Tick every STEP seconds from `from` to `to`; `each` runs before a tick. Returns ticks that threw. */
  async function run(k: ReturnType<typeof keeper>, from: number, to: number, each?: (now: number) => void) {
    let failed = 0
    for (let now = from; now <= to; now += STEP) {
      chain.warp(now)
      wall = now * 1000
      each?.(now)
      try { await k.tick() } catch { failed++ }
    }
    return failed
  }

  function lags(id: bigint) {
    const r = chain.rounds.get(id)!
    const t = chain.times(id)
    return { fix: r.fixedAt! - t.strikeEnd, settle: r.settledAt! - t.settleAt, outcome: r.outcome, reason: r.reason }
  }

  it('normal poll: fixStrike and settle land within one poll of becoming due', async () => {
    const id = chain.open(P1)
    const t = chain.times(id)
    await run(keeper(), t.closeAt + 9, t.settleAt + 60) // phase: the first tick after strikeEnd comes 9 s late
    const l = lags(id)
    expect(l.fix).toBeLessThanOrEqual(STEP)
    expect(l.settle).toBeLessThanOrEqual(STEP)
    expect(l).toMatchObject({ outcome: 1, reason: 0 })
  })

  it('an RPC failure for a whole tick right when each call becomes due costs one poll, no more', async () => {
    const id = chain.open(P1)
    const t = chain.times(id)
    const failed = await run(keeper(), t.closeAt + 9, t.settleAt + 60, (now) => {
      if (now > t.strikeEnd && now <= t.strikeEnd + STEP) chain.failLatest = 1
      if (now > t.settleAt && now <= t.settleAt + STEP) chain.failLatest = 1
    })
    expect(failed).toBe(2)
    const l = lags(id)
    expect(l.fix).toBeLessThanOrEqual(2 * STEP)
    expect(l.settle).toBeLessThanOrEqual(2 * STEP)
    expect(t.strikeEnd + l.fix).toBeLessThanOrEqual(FIX_BY(id))
    expect(l).toMatchObject({ outcome: 1, reason: 0 })
  })

  it('dry runs that revert for a while (pool unreadable 60 s and 90 s) are retried every poll and still land in time', async () => {
    const id = chain.open(P1)
    const t = chain.times(id)
    await run(keeper(), t.closeAt + 9, t.settleAt + 200, (now) => {
      const blocked = (now >= t.strikeEnd && now < t.strikeEnd + 60) || (now >= t.settleAt && now < t.settleAt + 90)
      if (blocked) chain.unpriceable.add(id)
      else chain.unpriceable.delete(id)
    })
    const l = lags(id)
    expect(l.fix).toBeGreaterThanOrEqual(60)
    expect(l.fix).toBeLessThanOrEqual(60 + STEP)
    expect(l.settle).toBeGreaterThanOrEqual(90)
    expect(l.settle).toBeLessThanOrEqual(90 + STEP)
    expect(l).toMatchObject({ outcome: 1, reason: 0 })
  })

  it('an on-chain revert out of gas costs one poll: the retry bids double with a larger limit', async () => {
    const id = chain.open(P1, { allowance: 10n ** 16n, up: 2n * ETH, down: 2n * ETH })
    const t = chain.times(id)
    chain.requiredGas.set('fixStrike', 200_000n)
    chain.requiredGas.set('settle', 300_000n)
    await run(keeper(), t.closeAt + 9, t.settleAt + 60)
    const l = lags(id)
    expect(l.fix).toBeLessThanOrEqual(2 * STEP)
    expect(l.settle).toBeLessThanOrEqual(2 * STEP)
    expect(l).toMatchObject({ outcome: 1, reason: 0 })
  })

  it('many rounds due at once: more than one tick can send, all within the deadline', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => chain.open(pool(0x60 + i)))
    const t = chain.times(ids[0])
    await run(keeper({ maxTxPerTick: 20 }), t.closeAt + 9, t.settleAt + 60)
    for (const id of ids) {
      const l = lags(id)
      expect(l.fix).toBeLessThanOrEqual(2 * STEP)
      expect(l.settle).toBeLessThanOrEqual(2 * STEP)
      expect(l.outcome).toBe(1)
    }
  })

  it('late means REFUND: a first call 2 s past fixStrikeBy finds the strike window gone (the fake keeps the rule honest)', async () => {
    const id = chain.open(P1)
    await run(keeper(), FIX_BY(id) + 2, FIX_BY(id) + 2)
    expect(chain.rounds.get(id)).toMatchObject({ outcome: 4, reason: 1 })
  })

  it('with a smaller ring the contract states tighter deadlines, and the keeper still makes them', async () => {
    tight()
    const id = chain.open(P1)
    const t = chain.times(id)
    expect(FIX_BY(id) - t.strikeEnd).toBe(119)
    await run(keeper(), t.closeAt + 9, t.settleAt + 60, (now) => {
      if (now > t.strikeEnd && now <= t.strikeEnd + STEP) chain.failLatest = 1
    })
    const l = lags(id)
    expect(l.fix).toBeLessThanOrEqual(2 * STEP)
    expect(l).toMatchObject({ outcome: 1, reason: 0 })
  })

  /**
   * Budget exhausted: the keeper may not pay, so it does not. The round stays
   * (tracked, reported), /health/deep goes red once the deadline passes, and
   * anyone can still call: settle() is permissionless.
   */
  it('budget exhausted: no call, the round stays, health goes red past the deadline, and anyone can settle', async () => {
    const id = chain.open(P1)
    const t = chain.times(id)
    await store.addSpent(id, 10n ** 15n) // the whole allowance
    const k = keeper()
    const health = () => evaluateRoundsHealth(async (key) => (key === ROUNDS_STATE_KEY ? JSON.stringify(store.snapshot) : null), wall)

    // The strike deadline (strikeEnd + 599) lies past settleAt here, so the
    // owed call becomes settle at settleAt, still against that deadline.
    await run(k, t.closeAt + 9, FIX_BY(id) - 40)
    expect(chain.sent).toEqual([])
    expect(await store.openRounds()).toEqual([id])
    expect(await health()).toMatchObject({ state: 'ok', warn: expect.arrayContaining(['rounds-deadline-at-risk']) })

    await run(k, FIX_BY(id) + 1, FIX_BY(id) + 11)
    expect(await store.openRounds()).toEqual([id])
    expect(await health()).toMatchObject({ state: 'down', code: 'rounds-deadline-missed' })

    // A player calls settle: on this busy pool the strike window is gone by
    // now, so it is REFUND, and the keeper lets the round go.
    chain.warp(FIX_BY(id) + 20)
    expect(chain.settleAsAnyone(id)).toBeNull()
    await run(k, FIX_BY(id) + 25, FIX_BY(id) + 25)
    expect(chain.rounds.get(id)).toMatchObject({ outcome: 4, reason: 1 })
    expect(await store.openRounds()).toEqual([])
    expect(chain.sent).toEqual([])
    expect(await health()).toMatchObject({ state: 'ok' })
  })
})

describe('the snapshot', () => {
  it('publishes waiting rounds, every owed deadline, at-risk and missed counts, the day\'s spend and the balance', async () => {
    tight()
    const a = chain.open(P1)
    const b = chain.open(P2)
    chain.open(P3, { up: 10n ** 17n, down: 0n })
    const t = chain.times(a)
    chain.unpriceable.add(a)
    const k = keeper()

    chain.warp(t.strikeEnd + 80) // a: 39 s left, cannot be priced; b: fixed now
    let rep = await k.tick()
    expect(rep.snapshot).toMatchObject({ open: 2, awaitingFixStrike: 1, atRisk: 1, deadlineMissed: 0, intervalMs: 10_000 })
    expect(rep.snapshot.deadlines).toEqual([
      { roundId: a.toString(), action: 'fixStrike', dueAt: t.strikeEnd, deadlineAt: FIX_BY(a), state: 'act' },
      { roundId: b.toString(), action: 'settle', dueAt: t.settleAt, deadlineAt: SETTLE_BY(b), state: 'wait' },
    ])

    chain.warp(t.strikeEnd + 125)
    rep = await k.tick()
    expect(rep.snapshot).toMatchObject({ atRisk: 0, deadlineMissed: 1 })
    expect(rep.snapshot.spent24hWei).toBe((80_000n * GWEI).toString())
    expect(rep.snapshot.keeperWei).toBe((5n * ETH).toString())
    expect(rep.snapshot.tickMs).toBeGreaterThanOrEqual(0)
    expect(store.snapshot).toEqual(rep.snapshot)
  })
})

/**
 * The depth rule's refund (RoundSettled reason 4): a round whose price windows
 * carried less depth than its bank needs is REFUND. The keeper names it, in
 * its logs and in health, rather than showing a number.
 */
describe('refunds by reason', () => {
  it('logs and counts a thin-window refund by name, and health warns', async () => {
    const id = chain.open(P1)
    chain.thinWindow.add(id)
    const warns: string[] = []
    const k = createRoundsKeeper({
      chain, store, sendTx: sendAt(2n * GWEI), gasGuard: guard, config: config(), nowMs: () => wall,
      log: { info: (m) => warns.push(m), warn: (m) => warns.push(m), error: (m) => warns.push(m) },
    })
    chain.warp(chain.times(id).strikeEnd)
    await k.tick()
    chain.warp(chain.times(id).strikeEnd + 10)
    const rep = await k.tick()
    expect(chain.rounds.get(id)).toMatchObject({ outcome: 4, reason: 4 })
    expect(warns.some((m) => /REFUND \(thin-window\)/.test(m))).toBe(true)
    expect(warns.some((m) => /\(4\)|reason 4/.test(m))).toBe(false)
    expect(rep.snapshot).toMatchObject({ settled24h: 1, refunds24h: { 'thin-window': 1 } })
    const v = await evaluateRoundsHealth(async (key) => (key === ROUNDS_STATE_KEY ? JSON.stringify(store.snapshot) : null), wall)
    expect(v).toMatchObject({ state: 'ok', warn: expect.arrayContaining(['rounds-refunds-thin']) })
  })

  it('counts rounds settled by anyone, once each, over the discovery overlap', async () => {
    const a = chain.open(P1)
    const b = chain.open(P2)
    for (const id of [a, b]) chain.quiet.add(id)
    const k = keeper({ logOverlap: 1_000_000n })
    chain.warp(chain.times(a).settleAt)
    expect(chain.settleAsAnyone(a)).toBeNull()
    await k.tick()
    await k.tick()
    const rep = await k.tick()
    // b settled by the keeper (UP), a by a player (UP): two, not six.
    expect(rep.snapshot.settled24h).toBe(2)
    expect(rep.snapshot.refunds24h).toEqual({})
  })
})

/**
 * The listing gate (re-audit V3-3): anyone may delist a pool that fell below
 * it. The keeper asks the contract about every listed pool by a dry run of
 * delistIfBelowGate, and delists the ones below the gate within a small daily
 * budget, as routine work. bet() refuses such a pool anyway; open rounds on it
 * run to the end either way.
 */
describe('the listing gate', () => {
  it('leaves healthy pools alone, at no cost', async () => {
    chain.listPool(P1)
    chain.open(P2)
    await keeper().tick()
    expect(new Set(chain.poolSims.map((p) => p.toLowerCase()))).toEqual(new Set([P1.toLowerCase(), P2.toLowerCase()]))
    expect(chain.sent).toEqual([])
    expect(store.snapshot!.pools).toMatchObject({ listed: 2, belowGate: [], delisted24h: 0 })
  })

  it('delists a pool below the gate as routine work, while its open round still settles', async () => {
    const id = chain.open(P1)
    const t = chain.times(id)
    const k = keeper()
    await k.tick()
    chain.pools.get(P1.toLowerCase())!.below = true
    chain.warp(T0 + 300) // the next gate check is 300 chain seconds after the first
    let rep = await k.tick()
    const d = rep.actions.find((a) => a.action === 'delistIfBelowGate')!
    expect(d.outcome).toMatchObject({ kind: 'sent', status: 'success', gasLimit: 120_000n })
    expect(chain.pools.get(P1.toLowerCase())!.listed).toBe(false)
    expect(guard.checks).toContain('routine')
    expect(guard.records).toEqual([{ cost: 65_000n * GWEI, priority: 'routine' }])
    expect(await store.getDaySpent('delist', new Date(wall).toISOString().slice(0, 10))).toBe(65_000n * GWEI)
    expect(rep.snapshot.pools).toMatchObject({ listed: 0, belowGate: [], delisted24h: 1 })
    const v = await evaluateRoundsHealth(async (key) => (key === ROUNDS_STATE_KEY ? JSON.stringify(store.snapshot) : null), wall)
    expect(v).toMatchObject({ state: 'ok', warn: expect.arrayContaining(['rounds-pool-thin']) })

    // The round on the delisted pool runs to the end.
    chain.warp(t.strikeEnd)
    await k.tick()
    chain.warp(t.settleAt)
    rep = await k.tick()
    expect(chain.rounds.get(id)).toMatchObject({ outcome: 1 })
  })

  it('checks on its own cadence, in chain seconds', async () => {
    chain.listPool(P1)
    const k = keeper({ poolCheckSec: 300 })
    await k.tick()
    chain.warp(T0 + 100)
    await k.tick()
    expect(chain.poolSims).toHaveLength(1)
    chain.warp(T0 + 300)
    await k.tick()
    expect(chain.poolSims).toHaveLength(2)
  })

  it('does not spend past its daily budget, and warns while the pool stays listed', async () => {
    chain.listPool(P1)
    chain.pools.get(P1.toLowerCase())!.below = true
    // 120 000 gas x 2 gwei = 2.4e14 at the plain quote: over a 1e14 budget.
    const rep = await keeper({ delistDailyBudgetWei: 10n ** 14n }).tick()
    expect(rep.actions.find((a) => a.action === 'delistIfBelowGate')!.outcome.kind).toBe('over-budget')
    expect(chain.sent).toEqual([])
    expect(rep.snapshot.pools.belowGate).toEqual([{ pool: P1, depthWei: ETH.toString() }])
    const v = await evaluateRoundsHealth(async (key) => (key === ROUNDS_STATE_KEY ? JSON.stringify(store.snapshot) : null), wall)
    expect(v).toMatchObject({ state: 'ok', warn: ['rounds-pool-thin'] })
  })

  it('can be told never to send, and respects the gas guard\'s routine limits', async () => {
    chain.listPool(P1)
    chain.pools.get(P1.toLowerCase())!.below = true
    let rep = await keeper({ delistDailyBudgetWei: null }).tick()
    expect(rep.actions.find((a) => a.action === 'delistIfBelowGate')!.outcome).toEqual({ kind: 'skipped', why: 'ROUNDS_DELIST_DAILY_BUDGET_ETH=off' })
    guard.routineSkip = 'daily gas budget spent'
    store = new MemoryRoundsStore()
    rep = await keeper().tick()
    expect(rep.actions.find((a) => a.action === 'delistIfBelowGate')!.outcome).toEqual({ kind: 'skipped', why: 'daily gas budget spent' })
    expect(chain.sent).toEqual([])
  })

  it('forgets a pool somebody else delisted already', async () => {
    chain.listPool(P1)
    chain.pools.get(P1.toLowerCase())!.listed = false // delisted without an event we have read yet
    await keeper().tick()
    expect(await store.listedPools()).toEqual([])
    expect(chain.sent).toEqual([])
  })
})
