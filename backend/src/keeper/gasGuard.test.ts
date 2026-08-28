import { describe, it, expect, beforeEach } from 'vitest'
import { createGasGuard, parseDecimalUnits, type GasGuardDeps } from './gasGuard.js'

const GWEI = 1_000_000_000n
const NOON = Date.parse('2026-08-28T12:00:00Z')

let fee: bigint
let spent: Record<string, bigint>
let clock: number
let deps: GasGuardDeps

beforeEach(() => {
  fee   = 6_000_000n // 0.006 gwei - Base at its floor
  spent = {}
  clock = NOON
  deps = {
    getMaxFeePerGas: async () => fee,
    getSpentWei:     async (day) => spent[day] ?? 0n,
    addSpentWei:     async (day, wei) => { spent[day] = (spent[day] ?? 0n) + wei },
    now:             () => clock,
  }
})

const cfg = {
  maxFeeWei:      150_000_000n,             // 0.15 gwei
  dailyBudgetWei: 2_000_000_000_000_000n,   // 0.002 ETH
}

const guard = () => createGasGuard(deps, cfg)

describe('fee ceiling', () => {
  it('lets routine work through at the normal Base fee', async () => {
    expect(await guard().check('routine')).toBeNull()
  })

  it('skips routine work when gas spikes past the ceiling', async () => {
    fee = 2n * GWEI

    expect(await guard().check('routine')).toMatch(/fee 2\.0+ gwei > ceiling/)
  })

  /**
   * The whole reason priorities exist. A price push that waits costs nothing
   * but freshness; a settlement that waits leaves someone's money locked in a
   * market that already resolved. A cost control that can strand user funds is
   * not a cost control, it is an outage with a budget attached.
   */
  it('never blocks a settlement, however expensive gas gets', async () => {
    fee = 500n * GWEI

    expect(await guard().check('critical')).toBeNull()
  })
})

describe('daily budget', () => {
  it('skips routine work once the day is spent', async () => {
    spent['2026-08-28'] = cfg.dailyBudgetWei

    expect(await guard().check('routine')).toMatch(/daily gas budget/)
  })

  it('still settles after the budget is gone', async () => {
    spent['2026-08-28'] = cfg.dailyBudgetWei * 10n

    expect(await guard().check('critical')).toBeNull()
  })

  it('resets at UTC midnight rather than 24h after the first spend', async () => {
    spent['2026-08-28'] = cfg.dailyBudgetWei
    const g = guard()
    expect(await g.check('routine')).not.toBeNull()

    clock = Date.parse('2026-08-29T00:00:01Z')
    expect(await g.check('routine')).toBeNull()
  })

  it('bills actual spend, not the pinned gas limit', async () => {
    const g = guard()
    // 300k gas actually burned at 0.006 gwei, against a 500k pinned limit.
    await g.record(300_000n, 6_000_000n)

    expect(spent['2026-08-28']).toBe(1_800_000_000_000n)
  })

  it('accumulates across transactions within the same day', async () => {
    const g = guard()
    await g.record(300_000n, 6_000_000n)
    await g.record(200_000n, 6_000_000n)

    expect(spent['2026-08-28']).toBe(3_000_000_000_000n)
  })
})

describe('throttle state', () => {
  it('starts clear and reports why once it trips', async () => {
    const g = guard()
    expect(g.state().throttled).toBe(false)

    fee = 2n * GWEI
    await g.check('routine')

    expect(g.state().throttled).toBe(true)
    expect(g.state().reason).toMatch(/ceiling/)
  })

  /**
   * A keeper silently skipping every price push looks identical to a healthy
   * one from the outside. It has to reach the health probe, or the throttle
   * becomes its own quiet 15-day outage.
   */
  it('clears once gas comes back down', async () => {
    const g = guard()
    fee = 2n * GWEI
    await g.check('routine')

    fee = 6_000_000n
    await g.check('routine')

    expect(g.state().throttled).toBe(false)
  })

  it('a critical send does not clear a throttle the ceiling still justifies', async () => {
    const g = guard()
    fee = 2n * GWEI
    await g.check('routine')
    await g.check('critical')

    expect(g.state().throttled).toBe(true)
  })
})

describe('failure to read the fee', () => {
  /**
   * Fail open, not closed. An RPC hiccup that silently stopped every price
   * push would be indistinguishable from the outage this guard is meant to
   * prevent, and the pinned gas limits already cap the damage per transaction.
   */
  it('lets work through when the RPC will not answer', async () => {
    deps.getMaxFeePerGas = async () => { throw new Error('rpc down') }

    expect(await guard().check('routine')).toBeNull()
  })
})

describe('parseDecimalUnits', () => {
  it('reads gwei without a float round-trip', () => {
    expect(parseDecimalUnits('0.15', 9)).toBe(150_000_000n)
    expect(parseDecimalUnits('2', 9)).toBe(2_000_000_000n)
  })

  it('keeps the tail of a small ETH amount', () => {
    expect(parseDecimalUnits('0.004', 18)).toBe(4_000_000_000_000_000n)
    expect(parseDecimalUnits('0.0005', 18)).toBe(500_000_000_000_000n)
  })

  it('truncates rather than rounding past the unit', () => {
    expect(parseDecimalUnits('0.1234567891', 9)).toBe(123_456_789n)
  })

  it('handles a bare integer and surrounding whitespace', () => {
    expect(parseDecimalUnits(' 1 ', 18)).toBe(1_000_000_000_000_000_000n)
  })
})
