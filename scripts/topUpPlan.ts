/**
 * How much to send a soak bot that has run low.
 *
 * Split out of bot-harness so the amounts stop being magic numbers. The
 * harness used to send a flat 0.01 ETH and 100 USDC to any bot that dipped
 * below its floor, which is what made `--bots 50` look like it needed 0.5 ETH
 * and 5,000 USDC of faucet - roughly 8,000 transactions of gas per bot at Base
 * Sepolia's 0.006 gwei, and 20x the default max bet in stake. Neither number
 * was a requirement; both were guesses, and together they were the reason the
 * 48h soak never ran.
 *
 * Topping up *to* a target rather than *by* a fixed amount also bounds what a
 * bot can accumulate over a long run.
 */

/**
 * Amount to send so `balance` reaches `target`, or 0 if it is still at or
 * above `floor`. Units are whatever the caller uses - wei or USDC base units.
 */
export function topUpAmount(balance: bigint, floor: bigint, target: bigint): bigint {
  if (target < floor) {
    throw new Error(`top-up target ${target} is below the floor ${floor}`)
  }
  if (balance >= floor) return 0n
  return target - balance
}
