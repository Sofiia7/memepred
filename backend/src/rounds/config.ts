/**
 * Whether the rounds keeper runs, and its knobs. Pure: reads only the object it
 * is given, so keeper/index.ts can import this without loading anything else of
 * the rounds module, and the tests need no environment.
 *
 * OFF BY DEFAULT. It starts only with ROUNDS_ENABLED=true AND a valid
 * ROUNDS_ADDRESS. Anything else leaves the keeper of the existing markets
 * exactly as it was: keeper/index.ts does not even load the rest of this
 * module.
 */
import { parseDecimalUnits } from '../keeper/gasGuard.js'
import { roundsDeploymentFromEnv, type RoundsDeployment } from './contract.js'

export interface RoundsConfig {
  deployment: RoundsDeployment
  /**
   * How often the rounds loop ticks. ROUNDS_INTERVAL_MS, default 5 s, allowed
   * 1-10 s and refused outside that. fixStrike and settle have hard deadlines
   * (keeperDeadlines: strikeEnd + 599 and settleAt + 839 with the defaults)
   * before a busy pool's ring loses the window; a slow poll eats that margin
   * before anything has even been tried, and a failed try needs a next one.
   */
  intervalMs: number
  /** Blocks per getLogs call. ROUNDS_LOG_CHUNK_BLOCKS, default 100 000: what the public RHC RPC serves. */
  logChunk: bigint
  /**
   * Blocks re-read behind the cursor on every tick. ROUNDS_LOG_OVERLAP_BLOCKS,
   * default 200 (about 16 s of RHC). A load-balanced RPC can answer a range from
   * a replica that has not reached its end yet; reading the tail twice is cheap
   * and every event is handled idempotently.
   */
  logOverlap: bigint
  /** First run without ROUNDS_START_BLOCK: how far back from the head to look. ROUNDS_LOOKBACK_BLOCKS, default 1 200 000 (~28 h). */
  lookbackBlocks: bigint
  /** getLogs calls per tick at most, so a long catch-up cannot hold the loop. ROUNDS_MAX_LOG_CHUNKS_PER_TICK, default 20. */
  maxChunksPerTick: number
  /** Blocks behind the head that discovery stops at. ROUNDS_CONFIRMATIONS, default 0. */
  confirmations: bigint
  /**
   * Share of a round's costAllowance held back for the SETTLE_GRACE settle.
   * ROUNDS_GRACE_RESERVE_BPS, default 2 000 (20%). fixStrike and settle may
   * spend up to allowance x (1 - reserve); the settle after settleAt + 24 h may
   * spend up to the whole allowance. See budget.ts.
   */
  graceReserveBps: bigint
  /**
   * Added to every worst-case transaction cost before it is checked against
   * the budget. ROUNDS_L1_RESERVE_WEI, default 0: on Arbitrum chains (RHC) the
   * L1 part is already inside gasUsed and the gas limit; an OP-stack chain bills
   * it separately (receipt.l1Fee) and would need a value here.
   */
  l1ReserveWei: bigint
  /** withdrawFees once feesAccrued reaches this. ROUNDS_FEES_WITHDRAW_MIN_ETH, default 0.01; "off" disables. */
  feesWithdrawMinWei: bigint | null
  /**
   * How long a tick waits for receipts (all at once) before leaving the rest
   * for the next tick. ROUNDS_RECEIPT_TIMEOUT_MS, default 20 s, 2-60 s. A long
   * wait holds the next tick back, and the next tick may carry a deadline.
   */
  receiptTimeoutMs: number
  /** Transactions per tick at most. ROUNDS_MAX_TX_PER_TICK, default 20. */
  maxTxPerTick: number
  /**
   * How often, in chain seconds, every listed pool is checked against the
   * listing gate. ROUNDS_POOL_CHECK_SEC, default 300, at least 30.
   */
  poolCheckSec: number
  /**
   * Daily budget, wei, for delistIfBelowGate on pools found below the gate.
   * ROUNDS_DELIST_DAILY_BUDGET_ETH, default 0.001; "off" checks and warns but
   * never sends. Routine work: the gas guard's fee ceiling and daily routine
   * budget apply on top.
   */
  delistDailyBudgetWei: bigint | null
}

export type RoundsConfigResult =
  | { enabled: false; error?: string }
  | { enabled: true; config: RoundsConfig }

/** The switch alone, for keeper/index.ts: true only for the exact string "true". */
export function roundsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ROUNDS_ENABLED ?? '').trim() === 'true'
}

export const INTERVAL_MIN_MS = 1_000
export const INTERVAL_MAX_MS = 10_000
export const INTERVAL_DEFAULT_MS = 5_000

/**
 * ROUNDS_INTERVAL_MS, strictly: unlike the other knobs, a bad value is not
 * replaced by the default but refuses the start. The poll is what the hard
 * deadlines depend on, and someone who wrote 30000 meant something; running
 * at a different cadence than written would hide the mistake.
 */
function interval(env: NodeJS.ProcessEnv): number | { error: string } {
  const raw = (env.ROUNDS_INTERVAL_MS ?? '').trim()
  if (!raw) return INTERVAL_DEFAULT_MS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < INTERVAL_MIN_MS || n > INTERVAL_MAX_MS) {
    return {
      error: `ROUNDS_INTERVAL_MS=${JSON.stringify(raw)} is outside ${INTERVAL_MIN_MS}-${INTERVAL_MAX_MS} ms: ` +
        'fixStrike and settle have hard deadlines (keeperDeadlines) and the poll must stay well inside them',
    }
  }
  return n
}

type Warn = (msg: string) => void

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, warn: Warn, max = Infinity): number {
  const raw = (env[name] ?? '').trim()
  if (!raw) return fallback
  const n = Number(raw)
  // Number('') is 0 and Number('15s') is NaN: either would turn a typo into a
  // hot loop or a zero budget. Same rule as positiveIntervalMs in keeper/index.ts.
  if (!Number.isInteger(n) || n < min || n > max) {
    warn(`[rounds] ignoring ${name}=${JSON.stringify(raw)} (must be an integer in [${min}, ${max}]), using ${fallback}`)
    return fallback
  }
  return n
}

function big(env: NodeJS.ProcessEnv, name: string, fallback: bigint, min: bigint, max: bigint | null, warn: Warn): bigint {
  const raw = (env[name] ?? '').trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw) || BigInt(raw) < min || (max !== null && BigInt(raw) > max)) {
    warn(`[rounds] ignoring ${name}=${JSON.stringify(raw)} (must be an integer in [${min}, ${max ?? 'inf'}]), using ${fallback}`)
    return fallback
  }
  return BigInt(raw)
}

function ethOrOff(env: NodeJS.ProcessEnv, name: string, fallback: string, warn: Warn): bigint | null {
  const raw = (env[name] ?? '').trim()
  if (raw.toLowerCase() === 'off') return null
  const value = raw || fallback
  if (!/^\d+(\.\d+)?$/.test(value)) {
    warn(`[rounds] ignoring ${name}=${JSON.stringify(raw)}, using ${fallback}`)
    return parseDecimalUnits(fallback, 18)
  }
  return parseDecimalUnits(value, 18)
}

function feesThreshold(env: NodeJS.ProcessEnv, warn: Warn): bigint | null {
  const raw = (env.ROUNDS_FEES_WITHDRAW_MIN_ETH ?? '').trim()
  if (raw.toLowerCase() === 'off') return null
  const value = raw || '0.01'
  if (!/^\d+(\.\d+)?$/.test(value)) {
    warn(`[rounds] ignoring ROUNDS_FEES_WITHDRAW_MIN_ETH=${JSON.stringify(raw)}, using 0.01`)
    return parseDecimalUnits('0.01', 18)
  }
  const wei = parseDecimalUnits(value, 18)
  // withdrawFees reverts NothingToWithdraw on zero, so a zero threshold would
  // dry-run it on every tick for nothing.
  return wei > 0n ? wei : 1n
}

export function readRoundsConfig(env: NodeJS.ProcessEnv = process.env, warn: Warn = console.warn): RoundsConfigResult {
  if (!roundsEnabled(env)) return { enabled: false }
  const deployment = roundsDeploymentFromEnv(env)
  if ('error' in deployment) return { enabled: false, error: deployment.error }
  const intervalMs = interval(env)
  if (typeof intervalMs !== 'number') return { enabled: false, error: intervalMs.error }

  return {
    enabled: true,
    config: {
      deployment,
      intervalMs,
      logChunk:           big(env, 'ROUNDS_LOG_CHUNK_BLOCKS', 100_000n, 1n, null, warn),
      logOverlap:         big(env, 'ROUNDS_LOG_OVERLAP_BLOCKS', 200n, 0n, null, warn),
      lookbackBlocks:     big(env, 'ROUNDS_LOOKBACK_BLOCKS', 1_200_000n, 0n, null, warn),
      maxChunksPerTick:   int(env, 'ROUNDS_MAX_LOG_CHUNKS_PER_TICK', 20, 1, warn),
      confirmations:      big(env, 'ROUNDS_CONFIRMATIONS', 0n, 0n, null, warn),
      graceReserveBps:    big(env, 'ROUNDS_GRACE_RESERVE_BPS', 2_000n, 0n, 9_000n, warn),
      l1ReserveWei:       big(env, 'ROUNDS_L1_RESERVE_WEI', 0n, 0n, null, warn),
      feesWithdrawMinWei: feesThreshold(env, warn),
      receiptTimeoutMs:   int(env, 'ROUNDS_RECEIPT_TIMEOUT_MS', 20_000, 2_000, warn, 60_000),
      maxTxPerTick:       int(env, 'ROUNDS_MAX_TX_PER_TICK', 20, 1, warn),
      poolCheckSec:       int(env, 'ROUNDS_POOL_CHECK_SEC', 300, 30, warn),
      delistDailyBudgetWei: ethOrOff(env, 'ROUNDS_DELIST_DAILY_BUDGET_ETH', '0.001', warn),
    },
  }
}
