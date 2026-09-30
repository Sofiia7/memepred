/**
 * What one keeper transaction may cost, and whether a round can still pay for it.
 *
 * ── The rule ──────────────────────────────────────────────────────────
 * Everything the keeper spends on a round, fixStrike and settle together,
 * successful and reverted, stays at or below that round's costAllowance: the
 * wei figure PoolRounds copied into the round at its first bet. The contract
 * only activates a round whose retained fee covers twice the allowance
 * (docs/rhc/ROUNDS-CONTRACT.md, decision 5), but it cannot see what the keeper
 * actually pays, since settle() is open to anyone. Keeping to the allowance is
 * this module's job.
 *
 * ── How "never above" is guaranteed rather than hoped for ─────────────
 * A transaction is only sent if the round's spend so far PLUS the most that
 * transaction can possibly cost fits under the cap. The most it can cost is
 * gasLimit x maxFeePerGas as attached (plus an L1 reserve on chains that bill L1 apart):
 * EIP-1559 never charges more than maxFeePerGas per unit, and never more units
 * than the limit. The check runs inside the send, against the fees actually
 * attached, so a fee escalated by keeperWallet.sendKeeperTx is checked too.
 * That worst case is booked BEFORE the send and trued up from the receipt
 * after; a keeper that dies in between leaves the round over-counted, never
 * under-counted.
 *
 * ── Hard deadlines come before the reserve, and before saving money ───
 * fixStrike must land by fixStrikeBy and settle by settleBy, the deadlines the
 * contract states in keeperDeadlines(roundId) (strikeEnd + 599 and settleAt +
 * 839 with the defaults): past them, on a busy pool, the round
 * turns into REFUND and every player pays 1%. So, until its deadline, such a
 * call:
 *
 *   - is never deferred for a cheaper gas price, not by one tick;
 *   - may spend the round's whole costAllowance (spendCap);
 *   - bids twice the quoted fee once it is urgent (bidFor): less than
 *     URGENT_SECS left, or an earlier attempt of the same call failed. On
 *     Arbitrum the fee actually charged is the base fee, so the higher cap
 *     costs nothing unless the base fee jumps between quote and inclusion,
 *     which is exactly the case it protects against; it only makes the
 *     worst case the budget must cover larger. If the doubled bid does not fit
 *     the room left, the bid is cut to what fits; only a round that cannot
 *     pay even the plain quote is not sent.
 *
 * ── The reserve for the last branch ───────────────────────────────────
 * After settleAt + 24 h a settle turns the round into REFUND without reading
 * the pool (~54 000 gas). That is the one call that always works, and it is
 * what releases the players' money when everything else failed. Once a call's
 * hard deadline has passed, that call may only bring the round's spend up to
 * allowance x (1 - reserve), so the 24 h settle can still be paid for; the
 * 24 h settle may use all of it. When even that does not fit, the keeper stops
 * for good on that round: settle() is permissionless, so any player can
 * release the round themselves.
 *
 * ── Gas limits: sized to the peak, from the node's estimate ───────────
 * The lesson of 2026-09-29 (settlementGas.ts, project memory): a limit sized
 * off "gas used" reverted twenty times in a row, because used is reported after
 * the refund for cleared storage and the limit must cover the peak before it.
 * So the limit is never below a floor per action and never below 130% of
 * estimateGas for exactly that call, and it grows x1.5 per consecutive on-chain
 * revert (settlementGas.escalatedGas, capped at x3). The estimate matters on the
 * testnet stand-in pools in particular: their observe() re-reads the whole
 * price history, so a settle there has been measured at 0.4-0.55 M gas and
 * grows with every price push, far above the figures for a real pool.
 */
import { escalatedGas } from '../keeper/settlementGas.js'

export type RoundAction = 'fixStrike' | 'settle' | 'graceSettle'
export type KeeperAction = RoundAction | 'withdrawFees' | 'delistIfBelowGate'

/**
 * Minimum gas limits. The figures are the "Итого, оценка" column of
 * ROUNDS-CONTRACT.md (forge --isolate, stand-in pool, plus an estimated
 * real-pool correction and 13 021 gas of L1), which already includes the L1
 * part that Arbitrum puts inside gasUsed:
 *
 *   fixStrike (2 points)                 80 276   -> floor 150 000
 *   settle, strike read here (5 points)  156 400  -> floor 260 000
 *   settle after SETTLE_GRACE            53 949   -> floor 100 000
 *   withdrawFees                         60 594 + 13 021 L1 -> floor 120 000
 *   delistIfBelowGate                    not measured by forge; reads slot0 and
 *                                        liquidity, writes one slot -> floor 120 000
 *
 * Unused gas is not charged, so a generous floor costs nothing on chain. It
 * does count against the budget check (the worst case is limit x fee), which is
 * why the grace floor is kept small: it must fit in the reserve.
 */
export const ROUNDS_GAS_FLOOR: Record<KeeperAction, bigint> = {
  fixStrike: 150_000n,
  settle: 260_000n,
  graceSettle: 100_000n,
  withdrawFees: 120_000n,
  delistIfBelowGate: 120_000n,
}

/** The gas limit for one send: max(floor, 130% of the estimate), raised per consecutive revert. */
export function roundsGasLimit(action: KeeperAction, estimate: bigint | null, revertStreak: number): bigint {
  const floor = ROUNDS_GAS_FLOOR[action]
  const fromEstimate = estimate !== null ? (estimate * 13n) / 10n : 0n
  return escalatedGas(fromEstimate > floor ? fromEstimate : floor, revertStreak)
}

/** Seconds before a hard deadline from which a call is urgent (and /health/deep warns). */
export const URGENT_SECS = 45
/** How much above the quote an urgent call bids. */
export const URGENT_FEE_MULTIPLIER = 2n

/**
 * How much of the allowance this action may bring the round's spend up to:
 * everything before a hard deadline and for the 24 h settle, allowance x
 * (1 - reserve) for a fixStrike or settle whose deadline has passed.
 */
export function spendCap(allowance: bigint, action: RoundAction, reserveBps: bigint, pastDeadline: boolean): bigint {
  if (action === 'graceSettle' || !pastDeadline) return allowance
  return allowance - (allowance * reserveBps) / 10_000n
}

/**
 * The fees to attach: the quote, or URGENT_FEE_MULTIPLIER times it when
 * urgent, cut down to what `roomWei` (cap minus spend minus L1 reserve) can
 * cover at `gasLimit`. Null when even the plain quote does not fit.
 */
export function bidFor(
  quote: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  urgent: boolean,
  gasLimit: bigint,
  roomWei: bigint,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null {
  const affordable = roomWei > 0n ? roomWei / gasLimit : 0n
  if (affordable < quote.maxFeePerGas) return null
  const want = urgent ? quote.maxFeePerGas * URGENT_FEE_MULTIPLIER : quote.maxFeePerGas
  const maxFeePerGas = want < affordable ? want : affordable
  const tip = urgent ? quote.maxPriorityFeePerGas * URGENT_FEE_MULTIPLIER : quote.maxPriorityFeePerGas
  return { maxFeePerGas, maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas }
}

/** The most one transaction can be charged. */
export function worstCaseWei(gasLimit: bigint, maxFeePerGas: bigint, l1ReserveWei: bigint): bigint {
  return gasLimit * maxFeePerGas + l1ReserveWei
}

/** What a receipt actually cost: execution plus the OP-stack L1 fee where there is one. */
export function receiptCostWei(r: { gasUsed: bigint; effectiveGasPrice: bigint; l1Fee?: bigint | null }): bigint {
  return r.gasUsed * r.effectiveGasPrice + (r.l1Fee ?? 0n)
}

/** Thrown from inside a send when the transaction would not fit; nothing is sent. */
export class RoundBudgetError extends Error {
  constructor(
    readonly roundId: bigint,
    readonly spentWei: bigint,
    readonly worstWei: bigint,
    readonly capWei: bigint,
  ) {
    super(`round ${roundId}: spent ${spentWei} + worst case ${worstWei} > cap ${capWei} wei`)
    this.name = 'RoundBudgetError'
  }
}
