/**
 * invariantMonitor - Sprint 5.6
 *
 * Periodic USDC conservation check across the orderbook.
 *
 * Per-market invariant (LP-aware, see migration 004): a market's on-chain USDC
 * balance must equal what it still OWES -
 *   A unmatched refundable remainder + B funds locked in unsettled matches (2×)
 *   + C settled-but-unclaimed user winnings.
 * LP-injected funds are the counterparty side of B and cancel on LP win (2×amount
 * leaves to the pool as the match flips to settled), so LP flow no longer drifts.
 * Pool/FeeDistributor solvency is out of scope (LiquidityPool.isFullyBacked()).
 *
 * Loop:
 *   1. expected = Σ per-market (A+B+C)  ← protocol_usdc_summary.expected_onchain_balance
 *   2. actual   = Σ on-chain USDC balanceOf(market) across all known markets.
 *   3. drift = abs(actual - expected).
 *   4. Write a row into invariant_snapshots with alert_level:
 *        ok       - drift ≤ 1 USDC (rounding + indexer lag)
 *        warn     - drift ≤ 10 USDC (indexer probably catching up)
 *        critical - drift > 10 USDC (real bug - page on-call)
 *
 * Alerts: critical writes a Redis flag `invariant:critical` which the
 * /api/keeper/health endpoint surfaces as 503.
 */
import { createPublicClient, http, type Address } from 'viem'
import { CHAIN_PROFILE } from '../chainProfile.js'
import { pg } from '../db/pg.js'
import { redis } from '../db/redis.js'
import { CONTRACTS } from '../config.js'

const chain = CHAIN_PROFILE.chain
const publicClient = createPublicClient({ chain, transport: http(CHAIN_PROFILE.rpcUrl) })

const USDC_BALANCE_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

/**
 * Drift thresholds, in whole units of the stake currency.
 *
 * A dollar and ten dollars on Base. On a chain staking WETH those would be
 * roughly two hundred and two thousand bets' worth, which is not a monitor -
 * so the rhc defaults are a MIN_BET and ten of them, the smallest drift that
 * could represent a real lost stake and the smallest that is clearly not
 * rounding.
 */
const DEFAULT_WARN = CHAIN_PROFILE.name === 'rhc' ? '0.005' : '1'
const DEFAULT_CRIT = CHAIN_PROFILE.name === 'rhc' ? '0.05' : '10'
const WARN_USDC = Number(process.env.INVARIANT_WARN_USDC ?? DEFAULT_WARN)
const CRIT_USDC = Number(process.env.INVARIANT_CRIT_USDC ?? DEFAULT_CRIT)

/**
 * The block the off-chain projection currently reflects.
 *
 * The orderbook stream's cursor: every order, match and settlement up to it has
 * been ingested, and nothing past it has. Undefined when there is no cursor yet
 * or the value cannot be read, which the caller treats as "compare at head".
 */
async function indexedBlock(): Promise<bigint | undefined> {
  try {
    const r = await pg.query(`SELECT last_block FROM _indexer_cursor WHERE stream = 'orderbook'`)
    if (r.rowCount === 0) return undefined
    return BigInt(r.rows[0].last_block)
  } catch {
    return undefined
  }
}

export type AlertLevel = 'ok' | 'warn' | 'critical'

/**
 * Turn a drift into an alert level.
 *
 * Pure and exported so the classification can be tested without a database, a
 * chain or a Redis - the arrangement `decidePool` uses, and for the same
 * reason: this is the branch that decides whether anyone is told the money is
 * missing.
 *
 * The non-finite case comes first and deliberately. Every comparison against
 * NaN is false, so `drift > crit` and `drift > warn` both fail and a plain
 * if/else-if chain falls through to "ok" - the one alarm that has to be
 * believed reporting green precisely because it could not compute anything.
 * That is not a hypothetical: five snapshots were written exactly that way,
 * every total NaN and the level "ok", when SUM() over an empty orders table
 * came back NULL. A drift that cannot be computed is not evidence the money is
 * there; it is the absence of evidence either way, and saying so is the job.
 */
export function classifyDrift(drift: number, warn: number, crit: number): AlertLevel {
  if (!Number.isFinite(drift)) return 'critical'
  if (drift > crit) return 'critical'
  if (drift > warn) return 'warn'
  return 'ok'
}

/**
 * NaN is a legal NUMERIC in Postgres and poisons every aggregate over the
 * column: one such row makes `max(abs(drift_usdc))` across a whole soak return
 * NaN. Store NULL instead, so the level carries the alarm and the history stays
 * queryable.
 */
export const finite = (n: number): number | null => (Number.isFinite(n) ? n : null)

export async function invariantTick() {
  if (!CONTRACTS.USDC || CONTRACTS.USDC === '0x') return

  // 1. Aggregate off-chain projection.
  const sumRow = await pg.query<{
    total_deposited: string; total_claimed: string; total_refunded: string;
    expected_onchain_balance: string;
  }>(`SELECT * FROM protocol_usdc_summary`)
  if (!sumRow.rows[0]) return
  const s = sumRow.rows[0]

  // SUM() over an empty orders table is NULL, and parseFloat(null) is NaN. That
  // put five snapshots into the table with every total NaN, an actual balance of
  // zero and an alert_level of "ok" - the monitor announcing that the money was
  // fine at a moment when it had not managed to count any of it.
  //
  // An empty book really does have zero deposited, so NULL becomes 0 and the
  // tick reads ok honestly. Anything else that will not parse stays NaN and is
  // caught below, where not-a-number is treated as the failure it is.
  const num = (v: string | null | undefined) => (v === null || v === undefined ? 0 : parseFloat(v))
  const totalDeposited = num(s.total_deposited)
  const totalClaimed   = num(s.total_claimed)
  const totalRefunded  = num(s.total_refunded)
  const expected       = num(s.expected_onchain_balance)

  // 2. Sum on-chain balances across all markets, AT THE BLOCK THE PROJECTION
  //    REFLECTS.
  //
  //    Reading at head compares two different moments: a bet that landed after
  //    the indexer's last tick is in the market's balance and not yet in the
  //    rows, so an active market sits at a permanent warn of about one stake.
  //    An alarm that is always yellow is one nobody reads, which is the failure
  //    mode this monitor is least able to afford.
  //
  //    Falls back to head when the block is unavailable - the public RPC keeps
  //    roughly eight minutes of state on this chain - because a comparison
  //    with a little race in it still beats none at all.
  const at = await indexedBlock()
  const markets = await pg.query<{ market_address: string }>(
    `SELECT market_address FROM markets`,
  )
  let actualWei = 0n
  for (const { market_address } of markets.rows) {
    try {
      const bal = await publicClient.readContract({
        address: CONTRACTS.USDC,
        abi: USDC_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [market_address as Address],
        ...(at === undefined ? {} : { blockNumber: at }),
      })
      actualWei += bal
    } catch (err) {
      console.error(`[invariant] balanceOf ${market_address} failed:`, err)
    }
  }
  // The stake currency's width, not USDC's. This was a literal 1e6, which on
  // an eighteen-decimal chain reported the balance a trillion times too large
  // and made the invariant monitor cry CRITICAL on every tick - the one alarm
  // that has to be believed.
  //
  // Scaled through BigInt rather than Number(actualWei) directly: 0.045 WETH is
  // 4.5e16 wei, already past the 9e15 where a double stops counting integers
  // exactly, so the old conversion would have started losing precision here
  // even if the divisor had been right.
  const UNIT = 10n ** BigInt(CHAIN_PROFILE.currencyDecimals)
  const MICRO = 1_000_000n
  const actual = Number((actualWei * MICRO) / UNIT) / 1e6
  const drift  = Math.abs(actual - expected)

  // 3. Classify and persist.
  const level = classifyDrift(drift, WARN_USDC, CRIT_USDC)

  await pg.query(
    `INSERT INTO invariant_snapshots
       (total_deposited, total_claimed, total_refunded, expected_balance,
        actual_balance, drift_usdc, alert_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (snapshot_at) DO NOTHING`,
    [finite(totalDeposited), finite(totalClaimed), finite(totalRefunded),
     finite(expected), finite(actual), finite(drift), level],
  )

  // 4. Surface critical via Redis flag for /api/keeper/health.
  if (level === 'critical') {
    await redis.setEx('invariant:critical', 300, JSON.stringify({
      drift, actual, expected, totalDeposited, totalClaimed, totalRefunded, at: Date.now(),
    }))
    console.error(
      Number.isFinite(drift)
        ? `[invariant] CRITICAL drift = $${drift.toFixed(6)} (expected $${expected}, actual $${actual})`
        : `[invariant] CRITICAL drift is not a number (expected ${expected}, actual ${actual}) - ` +
          `the projection could not be summed, so nothing here vouches for the balances`,
    )
  } else {
    await redis.del('invariant:critical')
    if (level === 'warn') {
      console.warn(`[invariant] warn drift = $${drift.toFixed(6)}`)
    }
  }
}
