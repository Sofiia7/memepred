/**
 * How much gas to attach to a settlement batch transaction.
 *
 * Split out of resolveKeeper.ts so the sizing rule can be tested without an
 * RPC client, following the pattern gasGuard.ts and refundEligibility.ts
 * already use for this file's neighbours.
 *
 * The old code pinned every settlement batch at a flat 1.8M gas regardless
 * of how many matches it was trying to settle. On Robinhood Chain, measured
 * settlement cost is 84,935 fixed + 162,029 per match against a live
 * mainnet pool's observation ring (docs/rhc/measurements/README.md - the
 * forge bench alone gave 129,675, which is what a limit sized off the bench
 * rather than the chain would have missed). 1.8M covers only 10-12 matches.
 * One MAX_BET order (0.04 ETH) can create up to 8 PvP matches on its own at
 * MIN_BET (0.005 ETH) each, so two such orders due in the same tick already
 * exceeds it - the batch reverted out of gas, and because the old code
 * retried the exact same 1.8M every 15 seconds on a revert, this turned one
 * busy moment into an unbounded loop of wasted gas that never settled
 * anything.
 */

export interface SettlementGasParams {
  /** Fixed per-transaction overhead, independent of match count. */
  fixedGas: bigint
  /** Marginal gas per match in the batch. */
  perMatchGas: bigint
  /** Extra headroom on top of the measured figures, in basis points. */
  bufferBps: bigint
}

export const RHC_SETTLEMENT_GAS: SettlementGasParams = {
  // Measured fixed part of a settlement tx (84,935), rounded up.
  fixedGas: 100_000n,
  // Measured marginal cost per match against a live mainnet pool (162,029),
  // rounded up. That figure predates the 1% protocol fee path (a transfer
  // plus a distributeFee call on each winning match), which has not been
  // separately remeasured - the extra headroom below is what covers it
  // until it has.
  perMatchGas: 200_000n,
  // 20% on top of the above, for the fee path and ordinary chain variance.
  bufferBps: 2000n,
}

/**
 * @param matchCount Matches in the batch being sent - callers already know
 *        this from the `ready` array they are about to submit, and already
 *        skip the call entirely when it is empty, so 0 or fewer here is a
 *        caller bug, not a batch that happens to be empty.
 */
export function settlementGasLimit(matchCount: number, params: SettlementGasParams): bigint {
  if (matchCount <= 0) {
    throw new Error(`settlementGasLimit: matchCount must be positive, got ${matchCount}`)
  }
  const base = params.fixedGas + params.perMatchGas * BigInt(matchCount)
  return base + (base * params.bufferBps) / 10_000n
}
