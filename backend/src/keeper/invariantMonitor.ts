/**
 * invariantMonitor — Sprint 5.6
 *
 * Periodic USDC conservation check across the orderbook.
 *
 * Loop:
 *   1. Sum deposits / claims / refunds from `orders` table.
 *   2. Sum on-chain USDC balance across all known market addresses.
 *   3. Compare: expected_balance = deposits - claims - refunds.
 *      drift = abs(actual - expected).
 *   4. Write a row into invariant_snapshots with alert_level:
 *        ok       — drift ≤ 1 USDC (rounding + indexer lag)
 *        warn     — drift ≤ 10 USDC (indexer probably catching up)
 *        critical — drift > 10 USDC (real bug — page on-call)
 *
 * Alerts: critical writes a Redis flag `invariant:critical` which the
 * /api/keeper/health endpoint surfaces as 503.
 */
import { createPublicClient, http, type Address } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { pg } from '../db/pg.js'
import { redis } from '../db/redis.js'
import { CONTRACTS } from '../config.js'

const chain = process.env.CHAIN_ID === '8453' ? base : baseSepolia
const publicClient = createPublicClient({ chain, transport: http(process.env.BASE_RPC_URL) })

const USDC_BALANCE_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

const WARN_USDC = Number(process.env.INVARIANT_WARN_USDC ?? '1')
const CRIT_USDC = Number(process.env.INVARIANT_CRIT_USDC ?? '10')

export async function invariantTick() {
  if (!CONTRACTS.USDC || CONTRACTS.USDC === '0x') return

  // 1. Aggregate off-chain projection.
  const sumRow = await pg.query<{
    total_deposited: string; total_claimed: string; total_refunded: string;
    expected_onchain_balance: string;
  }>(`SELECT * FROM protocol_usdc_summary`)
  if (!sumRow.rows[0]) return
  const s = sumRow.rows[0]
  const totalDeposited = parseFloat(s.total_deposited)
  const totalClaimed   = parseFloat(s.total_claimed)
  const totalRefunded  = parseFloat(s.total_refunded)
  const expected       = parseFloat(s.expected_onchain_balance)

  // 2. Sum on-chain USDC across all markets.
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
      })
      actualWei += bal
    } catch (err) {
      console.error(`[invariant] balanceOf ${market_address} failed:`, err)
    }
  }
  const actual = Number(actualWei) / 1e6
  const drift  = Math.abs(actual - expected)

  // 3. Classify and persist.
  let level: 'ok' | 'warn' | 'critical' = 'ok'
  if (drift > CRIT_USDC) level = 'critical'
  else if (drift > WARN_USDC) level = 'warn'

  await pg.query(
    `INSERT INTO invariant_snapshots
       (total_deposited, total_claimed, total_refunded, expected_balance,
        actual_balance, drift_usdc, alert_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (snapshot_at) DO NOTHING`,
    [totalDeposited, totalClaimed, totalRefunded, expected, actual, drift, level],
  )

  // 4. Surface critical via Redis flag for /api/keeper/health.
  if (level === 'critical') {
    await redis.setEx('invariant:critical', 300, JSON.stringify({
      drift, actual, expected, totalDeposited, totalClaimed, totalRefunded, at: Date.now(),
    }))
    console.error(`[invariant] CRITICAL drift = $${drift.toFixed(6)} (expected $${expected}, actual $${actual})`)
  } else {
    await redis.del('invariant:critical')
    if (level === 'warn') {
      console.warn(`[invariant] warn drift = $${drift.toFixed(6)}`)
    }
  }
}
