/**
 * What the rounds keeper must not forget across a restart, and where it lives.
 *
 *   cursor      last block discovery has read
 *   open set    rounds that may still owe keeper work
 *   pools       pools the contract lists, for the gate check
 *   day spend   wei spent per UTC day on delistIfBelowGate, against its own budget
 *   spent       wei spent per round - the budget rule is only as good as this
 *               number, so it survives restarts (budget.ts)
 *   spend log   every receipt with its time, for "spent in the last 24 h"
 *   snapshot    what /health/deep and /api/rounds/health read
 *
 * Redis in production, next to the gas guard's own counters
 * (keeper/gasGuardInstance.ts), so no database migration is involved. Keys are
 * namespaced by the PoolRounds address: a redeploy starts clean instead of
 * inheriting a cursor and an open set that belong to another contract. The
 * snapshot key is the exception, since there is one rounds keeper to report on.
 *
 * The in-memory store is for tests and the anvil run.
 */
import type { Address } from 'viem'
import { getAddress } from 'viem'

export const ROUNDS_STATE_KEY = 'rounds:state'
/**
 * The snapshot expires if the rounds loop stops publishing, so a keeper that
 * was switched off stops being reported on instead of reading as stale forever.
 * Longer than the stale threshold in health.ts (5 min), so a stalled loop is red
 * for the ten minutes in between before it goes quiet; every await in a tick is
 * bounded by an RPC or receipt timeout, so a tick cannot hang that long.
 */
export const ROUNDS_STATE_TTL_SEC = 15 * 60
/** A round lives about 27 h at most (3 600 s rounds, pause, strike window, SETTLE_GRACE); its spend is kept two weeks. */
const SPENT_TTL_SEC = 14 * 24 * 3600
const SPEND_LOG_KEEP_MS = 48 * 3600_000

/** One call the keeper owes with a hard deadline, as published for health. */
export interface DeadlineEntry {
  roundId: string
  action: 'fixStrike' | 'settle'
  /** Chain seconds: when the call became (or becomes) callable. */
  dueAt: number
  /** Chain seconds: the last second it still reads its window on a busy pool. */
  deadlineAt: number
  /** What the keeper made of it on this tick: act, wait, paused, over-budget. */
  state: string
}

/**
 * What the keeper publishes each tick. Every field is optional to readers: an
 * older keeper may have written it, and a keeper that refused to start writes
 * only `configError`.
 */
export interface RoundsSnapshot {
  version: 1
  /** Wall clock of the tick's end, ms. */
  lastTick: number
  /** Set instead of everything else when ROUNDS_ENABLED=true but the rounds keeper could not start. */
  configError?: string
  /** Chain time the tick planned against, seconds. */
  chainTime: number
  /** How long the tick took, ms, and the poll it runs on. */
  tickMs: number
  intervalMs: number
  contract: string
  headBlock: string
  cursorBlock: string | null
  /** Discovery reached the head this tick. */
  caughtUp: boolean
  open: number
  collecting: number
  /** Activated, waiting for strikeEnd or settleAt. */
  waiting: number
  awaitingFixStrike: number
  awaitingSettle: number
  awaitingGraceSettle: number
  overBudget: number
  paused: number
  /** Calls owed with a hard deadline, earliest deadline first (at most 100). */
  deadlines: DeadlineEntry[]
  /** At the tick: owed calls with less than URGENT_SECS (45) left, and ones past their deadline. */
  atRisk: number
  deadlineMissed: number
  /** Rounds seen settled in the last 24 h (by anyone), and the refunds among them by reason name. */
  settled24h: number
  refunds24h: Record<string, number>
  /** The gate check: listed pools, the ones found below the gate at the last check, delists by this keeper in 24 h. */
  pools: {
    listed: number
    belowGate: Array<{ pool: string; depthWei: string | null }>
    gateDepthWei: string | null
    delisted24h: number
    lastCheckChainTime: number | null
    delistSpentTodayWei: string
  }
  /** The due settle (normal or 24 h) that has waited longest, among rounds the keeper is still working. */
  oldestSettleOverdue: { roundId: string; secs: number } | null
  spent24hWei: string
  keeperWei: string | null
  feesAccruedWei: string | null
  txs: number
  /** Roundviews that did not match the ABI: the keeper refuses to act. */
  abiMismatch: boolean
  lastError: string | null
}

export interface RoundsStore {
  getCursor(): Promise<bigint | null>
  setCursor(block: bigint): Promise<void>
  openRounds(): Promise<bigint[]>
  addOpen(ids: bigint[]): Promise<void>
  removeOpen(ids: bigint[]): Promise<void>
  getSpent(roundId: bigint): Promise<bigint>
  /** Add (or, to true up a reservation, subtract) and return the new total. */
  addSpent(roundId: bigint, deltaWei: bigint): Promise<bigint>
  logSpend(atMs: number, wei: bigint, ref: string): Promise<void>
  spentSince(sinceMs: number): Promise<bigint>
  listedPools(): Promise<Address[]>
  addPools(pools: Address[]): Promise<void>
  removePools(pools: Address[]): Promise<void>
  /** Wei spent on one kind of routine work on a UTC day (YYYY-MM-DD). */
  getDaySpent(kind: string, day: string): Promise<bigint>
  addDaySpent(kind: string, day: string, deltaWei: bigint): Promise<bigint>
  publish(snapshot: RoundsSnapshot): Promise<void>
}

// ── in memory ─────────────────────────────────────────────────────────

export class MemoryRoundsStore implements RoundsStore {
  cursor: bigint | null = null
  readonly open = new Set<bigint>()
  readonly spent = new Map<bigint, bigint>()
  readonly spendLog: Array<{ atMs: number; wei: bigint; ref: string }> = []
  readonly pools = new Set<string>()
  readonly daySpent = new Map<string, bigint>()
  snapshot: RoundsSnapshot | null = null

  async getCursor() { return this.cursor }
  async setCursor(block: bigint) { this.cursor = block }
  async openRounds() { return [...this.open] }
  async addOpen(ids: bigint[]) { for (const id of ids) this.open.add(id) }
  async removeOpen(ids: bigint[]) { for (const id of ids) this.open.delete(id) }
  async getSpent(id: bigint) { return this.spent.get(id) ?? 0n }
  async addSpent(id: bigint, delta: bigint) {
    const next = (this.spent.get(id) ?? 0n) + delta
    this.spent.set(id, next)
    return next
  }
  async logSpend(atMs: number, wei: bigint, ref: string) { this.spendLog.push({ atMs, wei, ref }) }
  async spentSince(sinceMs: number) {
    return this.spendLog.filter((e) => e.atMs >= sinceMs).reduce((a, e) => a + e.wei, 0n)
  }
  async listedPools() { return [...this.pools].map((p) => getAddress(p)) }
  async addPools(pools: Address[]) { for (const p of pools) this.pools.add(p.toLowerCase()) }
  async removePools(pools: Address[]) { for (const p of pools) this.pools.delete(p.toLowerCase()) }
  async getDaySpent(kind: string, day: string) { return this.daySpent.get(`${kind}:${day}`) ?? 0n }
  async addDaySpent(kind: string, day: string, delta: bigint) {
    const next = (this.daySpent.get(`${kind}:${day}`) ?? 0n) + delta
    this.daySpent.set(`${kind}:${day}`, next)
    return next
  }
  async publish(s: RoundsSnapshot) { this.snapshot = s }
}

// ── Redis ─────────────────────────────────────────────────────────────

/** The node-redis v4 calls this store makes, so a test can hand it a Map. */
export interface RedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<unknown>
  setEx(key: string, seconds: number, value: string): Promise<unknown>
  sAdd(key: string, members: string[]): Promise<unknown>
  sRem(key: string, members: string[]): Promise<unknown>
  sMembers(key: string): Promise<string[]>
  zAdd(key: string, member: { score: number; value: string }): Promise<unknown>
  zRangeByScore(key: string, min: number | string, max: number | string): Promise<string[]>
  zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<unknown>
}

export function createRedisRoundsStore(redis: RedisLike, contract: Address): RoundsStore {
  const ns = `rounds:${contract.toLowerCase()}`
  const K = {
    cursor: `${ns}:cursor`,
    open: `${ns}:open`,
    spent: (id: bigint) => `${ns}:spent:${id}`,
    log: `${ns}:spendlog`,
    pools: `${ns}:pools`,
    day: (kind: string, day: string) => `${ns}:dayspent:${kind}:${day}`,
  }

  return {
    async getCursor() {
      const v = await redis.get(K.cursor)
      return v === null ? null : BigInt(v)
    },
    async setCursor(block) { await redis.set(K.cursor, block.toString()) },
    async openRounds() { return (await redis.sMembers(K.open)).map((s) => BigInt(s)) },
    async addOpen(ids) { if (ids.length) await redis.sAdd(K.open, ids.map(String)) },
    async removeOpen(ids) { if (ids.length) await redis.sRem(K.open, ids.map(String)) },
    async getSpent(id) { return BigInt((await redis.get(K.spent(id))) ?? '0') },
    async addSpent(id, delta) {
      // Read-modify-write, like gasGuardInstance: one keeper process writes these,
      // and the values are bigints that INCRBY's 64 bits would not always hold.
      const next = BigInt((await redis.get(K.spent(id))) ?? '0') + delta
      await redis.setEx(K.spent(id), SPENT_TTL_SEC, next.toString())
      return next
    },
    async logSpend(atMs, wei, ref) {
      // The member carries its own amount; the time and ref keep it unique.
      await redis.zAdd(K.log, { score: atMs, value: `${atMs}:${ref}:${wei}` })
      await redis.zRemRangeByScore(K.log, '-inf', atMs - SPEND_LOG_KEEP_MS)
    },
    async spentSince(sinceMs) {
      const rows = await redis.zRangeByScore(K.log, sinceMs, '+inf')
      let sum = 0n
      for (const r of rows) {
        const wei = r.slice(r.lastIndexOf(':') + 1)
        if (/^\d+$/.test(wei)) sum += BigInt(wei)
      }
      return sum
    },
    async listedPools() { return (await redis.sMembers(K.pools)).map((p) => getAddress(p)) },
    async addPools(pools) { if (pools.length) await redis.sAdd(K.pools, pools.map((p) => p.toLowerCase())) },
    async removePools(pools) { if (pools.length) await redis.sRem(K.pools, pools.map((p) => p.toLowerCase())) },
    async getDaySpent(kind, day) { return BigInt((await redis.get(K.day(kind, day))) ?? '0') },
    async addDaySpent(kind, day, delta) {
      const next = BigInt((await redis.get(K.day(kind, day))) ?? '0') + delta
      await redis.setEx(K.day(kind, day), 3 * 24 * 3600, next.toString())
      return next
    },
    async publish(s) { await redis.setEx(ROUNDS_STATE_KEY, ROUNDS_STATE_TTL_SEC, JSON.stringify(s)) },
  }
}
