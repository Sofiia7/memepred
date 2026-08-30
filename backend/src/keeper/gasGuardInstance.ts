/**
 * The keeper's single gas guard, wired to the chain and to Redis.
 *
 * Separate from gasGuard.ts so the policy stays a pure function of its inputs
 * and its tests do not need a database. Every keeper loop shares this one
 * instance, because the daily budget is a property of the wallet, not of
 * whichever loop happens to spend it first.
 *
 * ── The numbers are per chain, and that is not a detail ──────────────
 *
 * The first version of this file carried one pair of defaults calibrated on
 * Base mainnet (0.005 gwei base + 0.001 priority, measured 2026-08-28) with a
 * 0.15 gwei ceiling. Production runs on Base Sepolia, where the base fee that
 * same afternoon ranged 0.061-0.121 gwei - and viem's estimateFeesPerGas
 * multiplies the base fee by 1.2 before adding priority, so the quote sits
 * around 0.145 gwei. That ceiling would have started skipping routine work
 * within hours of being deployed: a cost control causing the outage it was
 * added to prevent.
 *
 * Measured on Base Sepolia, 2026-08-28, from the keeper wallet's own balance
 * across 38 minutes of normal operation: 0.0105 ETH/day, at ~349k gas and
 * ~0.055 gwei per market creation. The L1 data fee on that same transaction
 * was 0.000000006 ETH against 0.0000192 ETH of L2 execution - 0.03%, but it is
 * billed anyway so the figure stays honest if that ratio ever changes.
 *
 *   chain          ceiling     budget      headroom
 *   Base mainnet   0.15 gwei   0.004 ETH   ~25x fee, ~8x burn
 *   Base Sepolia   3 gwei      0.05 ETH    ~25x fee, ~5x burn
 *
 * Both are env-overridable via MAX_FEE_GWEI and DAILY_GAS_BUDGET_ETH. The point
 * is that a ceiling exists and that it is calibrated against the chain the code
 * actually runs on, not that these exact numbers are sacred.
 */
import { createPublicClient, http } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { redis } from '../db/redis.js'
import { createGasGuard, parseDecimalUnits, type Priority } from './gasGuard.js'

const isMainnet = process.env.CHAIN_ID === '8453'
const chain = isMainnet ? base : baseSepolia
const publicClient = createPublicClient({ chain, transport: http(process.env.BASE_RPC_URL) })

const DEFAULTS = isMainnet
  ? { maxFeeGwei: '0.15', dailyBudgetEth: '0.004' }
  : { maxFeeGwei: '3',    dailyBudgetEth: '0.05'  }

const envWei = (name: string, fallback: string, decimals: number): bigint =>
  parseDecimalUnits(process.env[name] ?? fallback, decimals)

const GAS_SPENT_KEY_TTL_SEC = 60 * 60 * 48 // two days: yesterday stays readable

export const gasGuard = createGasGuard(
  {
    getMaxFeePerGas: async () => {
      const fees = await publicClient.estimateFeesPerGas()
      return fees.maxFeePerGas
    },
    // Keyed by kind of work as well as by day. Settlements sharing a counter
    // with price pushes is what let a heavy settlement day stop price
    // recording, and price recording is what settlement reads.
    getSpentWei: async (day, priority) =>
      BigInt((await redis.get(`gas:spent:${day}:${priority}`)) ?? '0'),
    addSpentWei: async (day, priority, wei) => {
      const key = `gas:spent:${day}:${priority}`
      const next = BigInt((await redis.get(key)) ?? '0') + wei
      await redis.setEx(key, GAS_SPENT_KEY_TTL_SEC, next.toString())
    },
    now: Date.now,
  },
  {
    maxFeeWei:      envWei('MAX_FEE_GWEI',         DEFAULTS.maxFeeGwei,     9),
    dailyBudgetWei: envWei('DAILY_GAS_BUDGET_ETH', DEFAULTS.dailyBudgetEth, 18),
  },
)

/**
 * Bill a receipt, including the OP-stack L1 data fee. viem's Base chain
 * formatters put `l1Fee` on the receipt; it is read defensively because a
 * plain-EVM receipt carries no such field, and an undefined here would poison
 * the counter rather than fail loudly.
 */
export async function recordReceipt(
  receipt: { gasUsed: bigint; effectiveGasPrice: bigint; l1Fee?: bigint | null },
  priority: Priority,
): Promise<void> {
  await gasGuard.record(receipt.gasUsed, receipt.effectiveGasPrice, receipt.l1Fee ?? 0n, priority)
}
