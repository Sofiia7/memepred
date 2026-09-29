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

/**
 * Re-measured on the deployed testnet stack on 2026-09-29 (docs/rhc/DEPLOYMENTS.md,
 * transactions from scripts/rhc/e2e-verify.mts). Gas USED by a one-match batch:
 *
 *   vault-backed settle 287,871   PvP settle 293,038   resolver refund 216,000
 *
 * The earlier constants (100k + 200k per match, plus 20%) attached 360,000 to a
 * one-match batch. That looks like headroom over 288k and is not: a
 * transaction's limit has to cover its PEAK gas, which is before the refund for
 * the storage slots a settlement clears, and gas USED is reported after that
 * refund (capped at a fifth). The live keeper sent a one-match vault-backed
 * batch 20 times in a row, each reverted out of gas, and the match waited five
 * minutes until a second match became due and the pair, with its larger limit,
 * fitted. So the limit is sized for the peak of the dearest single match, and
 * the send path raises it on a revert instead of resending the same number.
 */
export const RHC_SETTLEMENT_GAS: SettlementGasParams = {
  // Fixed part of a settlement transaction (84,935 measured), rounded up.
  fixedGas: 120_000n,
  // The dearest single match seen (293,038 used) is about 365k at its peak, and
  // a later match in the same batch is cheaper (warm storage), so 260k per
  // match on top of the fixed part gives a one-match limit near 475k.
  perMatchGas: 260_000n,
  // 25% on top, for the fee path and ordinary chain variance.
  bufferBps: 2500n,
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

/** Reverts in a row after which a market is paused instead of resent every tick. */
export const REVERT_PAUSE_AFTER = 3

/** 30 s after the third revert in a row, doubling, never more than five minutes. */
export function revertPauseMs(streak: number): number {
  if (streak < REVERT_PAUSE_AFTER) return 0
  return Math.min(300_000, 30_000 * 2 ** (streak - REVERT_PAUSE_AFTER))
}

/**
 * The gas limit for a send after `streak` consecutive reverts: 1.5x per revert,
 * capped at three times the base. An identical resend of a transaction that ran
 * out of gas runs out of gas again, so each retry has to ask for more.
 */
export function escalatedGas(base: bigint, streak: number): bigint {
  let g = base
  for (let i = 0; i < streak; i++) g = (g * 15n) / 10n
  const cap = base * 3n
  return g > cap ? cap : g
}
