/**
 * Whether the keeper should spend money on a pool, and if not, why.
 *
 * Kept pure and separate from poolWatcher's chain access for two reasons. The
 * first is ordinary: this is where every judgement lives, so this is what has
 * to be tested, and testing it through an RPC client would test the client.
 *
 * The second is that these decisions cost real money and are easy to get
 * subtly wrong. 496 pools are created on this chain every day, 292 of them
 * paired with WETH, and growing one pool's observation ring costs about 6.7M
 * gas. A rule that says "increase cardinality" one tick too early, or that
 * forgets it already paid, spends that again. So the tick does no reasoning of
 * its own: it observes, asks here, and executes the answer.
 *
 * The contract enforces its own gates in PoolMarketFactory and will revert if
 * this module is wrong. These are not those gates. The contract's floor is
 * deliberately low (2 ETH of depth) so that anyone may create a market on a
 * thin pool at their own expense; this is the keeper's spending policy, which
 * is stricter, and the difference between the two is exactly the set of pools
 * we will not pay for but will not prevent.
 */

export interface PoolObservation {
  pool: string
  token0: string
  token1: string
  fee: number
  /** WETH behind the pool's in-range liquidity, in wei. */
  wethDepthWei: bigint
  /** Slots in the observation ring, from slot0(). */
  cardinality: number
  /** Slots paid for. Equal to `cardinality` unless a growth is pending. */
  cardinalityNext: number
  /**
   * Durations whose exit TWAP window the pool can serve right now, i.e. those
   * for which observe([window, 0]) does not revert OLD.
   */
  servableDurations: number[]
  /** Durations that already have a market. */
  existingDurations: number[]
  /** Seconds since the pool was created. */
  ageSec: number
  /** Whether we have already paid to grow this pool's ring. */
  cardinalityPaid: boolean
}

export interface AdmissionPolicy {
  weth: string
  /** The keeper's own threshold, not the contract's. */
  minDepthWei: bigint
  allowedFeeTiers: number[]
  durations: number[]
  minCardinality: number
  /** What to grow the ring to when paying. */
  cardinalityTarget: number
  /**
   * Give up on a pool that has stayed unfit this long.
   *
   * Without it the deferred set only grows: at 292 WETH pools a day, a watcher
   * that re-checks every pool it has ever seen is doing thousands of RPC reads
   * a tick within a week, to keep asking whether a pool that never had
   * liquidity has any yet.
   */
  maxPendingAgeSec: number
}

export type PoolDecision =
  /** Permanently unfit. Stop looking at it. */
  | { action: 'reject'; reason: string }
  /** Not fit yet, but might be. Check again later. */
  | { action: 'defer'; reason: string }
  /** Pay to grow the observation ring. */
  | { action: 'increaseCardinality'; target: number; reason: string }
  /** Create markets for these durations. */
  | { action: 'create'; durations: number[]; reason: string }
  /** Every allowed duration already has a market. */
  | { action: 'done'; reason: string }

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Formats wei as ETH with three decimals, for log lines and reasons. */
export function formatEth(wei: bigint): string {
  const whole = wei / 10n ** 18n
  const milli = (wei % 10n ** 18n) / 10n ** 15n
  return `${whole}.${milli.toString().padStart(3, '0')} ETH`
}

export function decidePool(obs: PoolObservation, policy: AdmissionPolicy): PoolDecision {
  // ── Permanent rejections first. These cannot change, so a pool that fails
  //    one should never be observed again.
  if (!eq(obs.token0, policy.weth) && !eq(obs.token1, policy.weth)) {
    return { action: 'reject', reason: 'not a WETH pair' }
  }
  if (!policy.allowedFeeTiers.includes(obs.fee)) {
    return { action: 'reject', reason: `fee tier ${obs.fee} not allowed` }
  }

  // ── Everything below can change with time, so it defers rather than
  //    rejects - up to the point where waiting has stopped being plausible.
  const tooOld = obs.ageSec > policy.maxPendingAgeSec

  if (obs.wethDepthWei < policy.minDepthWei) {
    const detail = `depth ${formatEth(obs.wethDepthWei)} below keeper threshold ${formatEth(policy.minDepthWei)}`
    return tooOld
      ? { action: 'reject', reason: `${detail}, and ${Math.floor(obs.ageSec / 3600)}h old` }
      : { action: 'defer', reason: detail }
  }

  // ── The ring. Paying is the expensive step, so it happens once and only
  //    after the pool has proved it holds enough to be worth pricing.
  if (obs.cardinality < policy.minCardinality) {
    if (obs.cardinalityPaid || obs.cardinalityNext >= policy.cardinalityTarget) {
      // Already paid for. Uniswap raises cardinality to cardinalityNext on the
      // pool's next write, so this resolves itself as soon as somebody trades.
      return {
        action: 'defer',
        reason: `ring paid for (${obs.cardinalityNext}) but still at ${obs.cardinality}, waiting for a swap`,
      }
    }
    return {
      action: 'increaseCardinality',
      target: policy.cardinalityTarget,
      reason: `cardinality ${obs.cardinality} below ${policy.minCardinality}`,
    }
  }

  // ── Markets. Only for durations whose window the pool can actually serve:
  //    a full ring is capacity, not history, and a market created before the
  //    history exists is one whose first settlements refund.
  const missing = policy.durations.filter((d) => !obs.existingDurations.includes(d))
  if (missing.length === 0) {
    return { action: 'done', reason: 'every allowed duration has a market' }
  }

  const creatable = missing.filter((d) => obs.servableDurations.includes(d))
  if (creatable.length === 0) {
    return {
      action: 'defer',
      reason: `no history yet for ${missing.join('/')}s; ring holds less than their windows`,
    }
  }

  return {
    action: 'create',
    durations: creatable,
    reason: `depth ${formatEth(obs.wethDepthWei)}, cardinality ${obs.cardinality}`,
  }
}
