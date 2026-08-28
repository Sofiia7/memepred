/**
 * The keeper's single gas guard, wired to the chain and to Redis.
 *
 * Separate from gasGuard.ts so the policy stays a pure function of its inputs
 * and its tests do not need a database. Every keeper loop shares this one
 * instance, because the daily budget is a property of the wallet, not of
 * whichever loop happens to spend it first.
 *
 * Defaults, and the reasoning behind the numbers:
 *
 *   MAX_FEE_GWEI=0.15         Base sat at 0.006 gwei all-in on 2026-08-28
 *                             (0.005 base + 0.001 priority). 0.15 is ~25x that
 *                             - far above any normal day, low enough to cut off
 *                             a real congestion spike.
 *   DAILY_GAS_BUDGET_ETH=0.004  Roughly 8x the measured ~0.0005 ETH/day burn.
 *                             Wide enough that a busy day never trips it,
 *                             tight enough that a runaway loop is capped at a
 *                             couple of dollars instead of the whole wallet.
 *
 * Both are env-overridable: the point is that a ceiling exists, not that these
 * exact numbers are sacred.
 */
import { createPublicClient, http } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { redis } from '../db/redis.js'
import { createGasGuard, parseDecimalUnits } from './gasGuard.js'

const chain = process.env.CHAIN_ID === '8453' ? base : baseSepolia
const publicClient = createPublicClient({ chain, transport: http(process.env.BASE_RPC_URL) })

const envWei = (name: string, fallback: string, decimals: number): bigint =>
  parseDecimalUnits(process.env[name] ?? fallback, decimals)

const GAS_SPENT_KEY_TTL_SEC = 60 * 60 * 48 // two days: yesterday stays readable

export const gasGuard = createGasGuard(
  {
    getMaxFeePerGas: async () => {
      const fees = await publicClient.estimateFeesPerGas()
      return fees.maxFeePerGas
    },
    getSpentWei: async (day) => BigInt((await redis.get(`gas:spent:${day}`)) ?? '0'),
    addSpentWei: async (day, wei) => {
      const key = `gas:spent:${day}`
      const next = BigInt((await redis.get(key)) ?? '0') + wei
      await redis.setEx(key, GAS_SPENT_KEY_TTL_SEC, next.toString())
    },
    now: Date.now,
  },
  {
    maxFeeWei:      envWei('MAX_FEE_GWEI',         '0.15',  9),
    dailyBudgetWei: envWei('DAILY_GAS_BUDGET_ETH', '0.004', 18),
  },
)
