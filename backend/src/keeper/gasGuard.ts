/**
 * Gas spend guard for the keeper.
 *
 * The keeper sends transactions on nine independent timers and, until this
 * module, would pay whatever the network asked. Base normally sits on its fee
 * floor (0.005 gwei base + 0.001 priority, measured 2026-08-28), but the
 * floor is not a promise: congestion has historically taken it one to two
 * orders of magnitude higher, and the times it does that are exactly the times
 * a memecoin market is busy. An unbounded keeper drains its wallet during the
 * one hour it most needs to be alive.
 *
 * Two limits, one rule about who they apply to:
 *
 *   fee ceiling    a per-transaction cap on maxFeePerGas
 *   daily budget   a cap on total ETH burned per UTC day
 *
 * Both apply to ROUTINE work only - price heartbeats, market rollovers. A
 * price push that waits for cheaper gas costs freshness. A settlement that
 * waits leaves somebody's money locked in a market that already resolved, and
 * a cost control that can strand user funds is not a cost control, it is an
 * outage with a budget attached. CRITICAL work is never blocked; it is logged
 * loudly and billed against the same counter so the number stays honest.
 *
 * The guard fails open. If the RPC will not quote a fee, work proceeds: the
 * pinned per-transaction gas limits already bound the damage, and a guard that
 * silently stops the keeper on an RPC hiccup reproduces the failure it exists
 * to prevent.
 */

export type Priority = 'critical' | 'routine'

export interface GasGuardDeps {
  /** Current maxFeePerGas the chain would charge, in wei. */
  getMaxFeePerGas: () => Promise<bigint>
  getSpentWei:     (day: string) => Promise<bigint>
  addSpentWei:     (day: string, wei: bigint) => Promise<void>
  now:             () => number
}

export interface GasGuardConfig {
  maxFeeWei:      bigint
  dailyBudgetWei: bigint
}

export interface GasGuardState {
  throttled: boolean
  reason:    string | null
  /** Set on the last check; -1 when the fee could not be read. */
  lastFeeWei: bigint
}

export interface GasGuard {
  /** Null to proceed; a human-readable reason to skip. */
  check:  (priority: Priority) => Promise<string | null>
  /** Bill an actual receipt against today's budget. */
  record: (gasUsed: bigint, effectiveGasPrice: bigint, l1FeeWei?: bigint) => Promise<void>
  state:  () => GasGuardState
}

/**
 * "0.15" gwei -> 150000000n. Parsed as a decimal string rather than through
 * Number(), because a float round-trip is how a ceiling silently ends up a
 * thousand times larger than the one that was written down.
 */
export function parseDecimalUnits(raw: string, decimals: number): bigint {
  const [whole, frac = ''] = raw.trim().split('.')
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals)
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0')
}

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function gwei(wei: bigint): string {
  return (Number(wei) / 1e9).toFixed(3)
}

export function createGasGuard(deps: GasGuardDeps, cfg: GasGuardConfig): GasGuard {
  let throttled  = false
  let reason: string | null = null
  let lastFeeWei = -1n

  async function check(priority: Priority): Promise<string | null> {
    let fee: bigint
    try {
      fee = await deps.getMaxFeePerGas()
      lastFeeWei = fee
    } catch (err) {
      // Fail open - see the header comment.
      console.warn('[gasGuard] could not read fee, proceeding:', (err as Error).message)
      lastFeeWei = -1n
      return null
    }

    const overCeiling = fee > cfg.maxFeeWei
    const day    = utcDay(deps.now())
    const spent  = await deps.getSpentWei(day)
    const overBudget = spent >= cfg.dailyBudgetWei

    const why = overCeiling
      ? `fee ${gwei(fee)} gwei > ceiling ${gwei(cfg.maxFeeWei)} gwei`
      : overBudget
        ? `daily gas budget spent (${gwei(spent)} gwei-wei of ${gwei(cfg.dailyBudgetWei)})`
        : null

    // The throttle flag tracks the network, not the caller: a settlement that
    // pushes through an expensive block does not mean gas got cheap.
    throttled = why !== null
    reason    = why

    if (priority === 'critical') {
      if (why) console.warn(`[gasGuard] proceeding with critical send despite: ${why}`)
      return null
    }

    if (why) console.warn(`[gasGuard] skipping routine send: ${why}`)
    return why
  }

  async function record(gasUsed: bigint, effectiveGasPrice: bigint, l1FeeWei = 0n): Promise<void> {
    // The receipt, not the pinned limit. Unused gas is never charged, and
    // billing the limit would show a budget three times larger than reality.
    //
    // l1FeeWei is the OP-stack data-availability charge, which does not appear
    // in gasUsed * effectiveGasPrice at all. It measured 0.03% of a Base
    // Sepolia market creation on 2026-08-28 - negligible today, and exactly
    // the kind of quietly-omitted term that makes a budget wrong later.
    await deps.addSpentWei(utcDay(deps.now()), gasUsed * effectiveGasPrice + l1FeeWei)
  }

  return { check, record, state: () => ({ throttled, reason, lastFeeWei }) }
}
