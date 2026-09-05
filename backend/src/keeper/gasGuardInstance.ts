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
import { CHAIN_PROFILE } from '../chainProfile.js'
import { redis } from '../db/redis.js'
import { createGasGuard, parseDecimalUnits, type Priority } from './gasGuard.js'

const publicClient = createPublicClient({ chain: CHAIN_PROFILE.chain, transport: http(CHAIN_PROFILE.rpcUrl) })

/**
 * ArbGasInfo, the precompile that knows what execution actually costs.
 *
 * On Robinhood Chain `eth_gasPrice` answers 0.45-0.56 gwei while transactions
 * execute at `perArbGasTotal`, measured at 1.7-1.8 gwei the same minute - about
 * four times more. A guard reading the wrong one has both halves of its job
 * wrong: it never throttles, because the quote is always under the ceiling, and
 * it under-bills the daily budget by the same factor.
 */
const ARB_GAS_INFO_ABI = [
  {
    name: 'getPricesInWei',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'perL2Tx', type: 'uint256' },
      { name: 'perL1CalldataByte', type: 'uint256' },
      { name: 'perStorageAllocation', type: 'uint256' },
      { name: 'perArbGasBase', type: 'uint256' },
      { name: 'perArbGasCongestion', type: 'uint256' },
      { name: 'perArbGasTotal', type: 'uint256' },
    ],
  },
] as const

const isMainnet = CHAIN_PROFILE.chain.id === 8453 || CHAIN_PROFILE.chain.id === 4663

/**
 * Robinhood Chain defaults, and why they are loose.
 *
 * Sampled 2026-09-04/05: perArbGasTotal ran 0.383 to 3.059 gwei with a p90 of
 * 0.612, and the *baseline* itself moved from ~1.75 gwei one day to ~0.4 the
 * next. A ceiling tuned to today's baseline would strangle the keeper the week
 * congestion returns to last week's, so 4 gwei sits above everything observed
 * including the spike, and still stops a genuine order-of-magnitude event.
 *
 * The budget covers routine work only, which here is onboarding pools:
 * ~7.9M gas each (ring plus three markets), about 7 pools a day at the
 * keeper's 20 ETH depth threshold, so ~0.034 ETH/day at p90. 0.1 leaves ~3x.
 * Settlements are critical and are never budget-blocked.
 */
const DEFAULTS = CHAIN_PROFILE.name === 'rhc'
  ? { maxFeeGwei: '4', dailyBudgetEth: '0.1' }
  : isMainnet
    ? { maxFeeGwei: '0.15', dailyBudgetEth: '0.004' }
    : { maxFeeGwei: '3',    dailyBudgetEth: '0.05'  }

const envWei = (name: string, fallback: string, decimals: number): bigint =>
  parseDecimalUnits(process.env[name] ?? fallback, decimals)

const GAS_SPENT_KEY_TTL_SEC = 60 * 60 * 48 // two days: yesterday stays readable

export const gasGuard = createGasGuard(
  {
    getMaxFeePerGas: async () => {
      if (CHAIN_PROFILE.usesArbGasInfo && CHAIN_PROFILE.addresses.arbGasInfo) {
        const prices = await publicClient.readContract({
          address: CHAIN_PROFILE.addresses.arbGasInfo,
          abi: ARB_GAS_INFO_ABI,
          functionName: 'getPricesInWei',
        })
        return prices[5] // perArbGasTotal
      }
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
