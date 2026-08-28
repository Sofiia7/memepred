/**
 * Fee escalation for a wedged nonce.
 *
 * Found in production on 2026-08-28 with the keeper stuck for over an hour and
 * every single write failing. The sequence:
 *
 *   1. Base Sepolia's base fee spiked from 0.005 to 0.121 gwei. viem quoted
 *      maxFeePerGas from the pre-spike base, so a transaction went out priced
 *      at 0.007 gwei and could not be included.
 *   2. It stayed in the mempool. Every later transaction from the keeper is
 *      behind that nonce, so nothing else could land either.
 *   3. Each retry re-quoted the fee from the same source, produced the same
 *      0.007 gwei, and was rejected: a replacement must pay at least 10% more
 *      than the transaction it replaces. "replacement transaction underpriced".
 *
 * The keeper could not get out of this on its own. It retried forever at a
 * price that was rejected by definition, no settlements, no price pushes, no
 * market rollovers - and the public Base RPC reports `pending` == `latest`
 * because it does not expose its txpool, so the stuck transaction was
 * invisible to every diagnostic that asks the node politely.
 *
 * The fix is to notice the error and pay more. Each consecutive failure at the
 * same nonce multiplies the fee by 1.25, comfortably clear of the 10% floor,
 * until the replacement displaces the stuck transaction or the ceiling stops
 * it. A success resets the counter.
 *
 * Deliberately keyed on the nonce, not on a global attempt count: a failure at
 * a NEW nonce is a different problem (funds, a revert, a dead RPC) and must not
 * inherit an inflated price from an unrelated earlier incident.
 */

export interface Fees {
  maxFeePerGas:         bigint
  maxPriorityFeePerGas: bigint
}

/** A replacement must beat the stuck transaction by 10%; 25% leaves margin. */
const STEP_NUM = 5n
const STEP_DEN = 4n

/**
 * Errors that mean "this nonce is occupied and you did not outbid it". Matched
 * on text because every RPC spells the code differently and viem flattens the
 * provider error into the message chain.
 */
const STUCK = /replacement transaction underpriced|already known|transaction underpriced/i

/**
 * "insufficient funds for gas * price + value". On its own this means top up
 * the wallet. Arriving *while a nonce is already known to be wedged* it means
 * something else: the bid needed to displace the stuck transaction has grown
 * past what the wallet can pay WITH THE REAL TRANSACTION'S GAS LIMIT attached.
 * That is not a dead end, it is the signal to stop bidding with 800,000 gas
 * and displace the nonce with 21,000 instead.
 *
 * Missing this distinction left production wedged at 0.159 gwei: the escalator
 * only counted stuck-nonce errors, so once the bid turned unaffordable the
 * level stopped climbing and the cheap displacement - which the wallet could
 * easily have afforded - was never attempted again.
 */
export function isInsufficientFundsError(err: unknown): boolean {
  const msg = err instanceof Error
    ? `${err.message} ${(err as { details?: string }).details ?? ''}`
    : String(err)
  return /insufficient funds/i.test(msg)
}

export function isStuckNonceError(err: unknown): boolean {
  const msg = err instanceof Error
    ? `${err.message} ${(err as { details?: string }).details ?? ''}`
    : String(err)
  return STUCK.test(msg)
}

/** 1.25^attempts applied to both fee components. attempts=0 returns the input. */
export function escalate(base: Fees, attempts: number): Fees {
  let { maxFeePerGas, maxPriorityFeePerGas } = base
  for (let i = 0; i < attempts; i++) {
    maxFeePerGas         = (maxFeePerGas         * STEP_NUM) / STEP_DEN
    maxPriorityFeePerGas = (maxPriorityFeePerGas * STEP_NUM) / STEP_DEN
  }
  return { maxFeePerGas, maxPriorityFeePerGas }
}

/**
 * Tracks consecutive stuck-nonce failures so the next attempt bids higher.
 * One instance per keeper process, shared by every loop, because they all
 * share one nonce sequence.
 */
export class NonceEscalation {
  private nonce = -1
  private attempts = 0

  /** Fees to use for the transaction about to be sent at `nonce`. */
  next(nonce: number, base: Fees): Fees {
    if (nonce !== this.nonce) { this.nonce = nonce; this.attempts = 0 }
    return escalate(base, this.attempts)
  }

  /** Call after a send that produced a stuck-nonce error. */
  bump(nonce: number): number {
    if (nonce !== this.nonce) { this.nonce = nonce; this.attempts = 0 }
    return ++this.attempts
  }

  /** Call after any send that got a transaction hash back. */
  succeeded(): void {
    this.nonce = -1
    this.attempts = 0
  }

  get level(): number { return this.attempts }
  get stuckNonce(): number | null { return this.attempts > 0 ? this.nonce : null }
}


/**
 * Escalations at one nonce before giving up on the real transaction and simply
 * displacing the stuck one with an empty self-transfer.
 *
 * Bidding up the real transaction is the obvious move and it has a floor the
 * wallet can hit: production on 2026-08-28 reached
 * `have 72038606089498 want 127329237600000` - the keeper could not afford the
 * bid because it was bidding with a 800,000-gas limit attached. A cancel needs
 * 21,000 gas, roughly 40x less, so the same wallet can outbid a stranded
 * transaction at a fee it could never afford to attach to real work.
 */
export const CANCEL_AFTER_ESCALATIONS = 4

export function shouldCancelNonce(level: number): boolean {
  return level >= CANCEL_AFTER_ESCALATIONS
}
