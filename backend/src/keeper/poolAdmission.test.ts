import { describe, it, expect } from 'vitest'
import { decidePool, formatEth, type PoolObservation, type AdmissionPolicy } from './poolAdmission.js'

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
const TOKEN = '0x1111111111111111111111111111111111111111'

const policy: AdmissionPolicy = {
  weth: WETH,
  minDepthWei: 20n * 10n ** 18n, // the keeper's 20 ETH, not the contract's 2
  allowedFeeTiers: [500, 3000, 10000],
  durations: [60, 300, 900],
  minCardinality: 300,
  cardinalityTarget: 300,
  maxPendingAgeSec: 24 * 3600,
}

const pool = (over: Partial<PoolObservation> = {}): PoolObservation => ({
  pool: '0xpool',
  token0: TOKEN,
  token1: WETH,
  fee: 10000,
  wethDepthWei: 50n * 10n ** 18n,
  cardinality: 300,
  cardinalityNext: 300,
  servableDurations: [60, 300, 900],
  existingDurations: [],
  ageSec: 3600,
  cardinalityPaid: false,
  ...over,
})

describe('decidePool', () => {
  it('creates markets for a pool that passes everything', () => {
    const d = decidePool(pool(), policy)
    expect(d.action).toBe('create')
    if (d.action === 'create') expect(d.durations).toEqual([60, 300, 900])
  })

  it('creates only the durations that are still missing', () => {
    const d = decidePool(pool({ existingDurations: [60] }), policy)
    expect(d.action).toBe('create')
    if (d.action === 'create') expect(d.durations).toEqual([300, 900])
  })

  it('reports done once every duration has a market', () => {
    expect(decidePool(pool({ existingDurations: [60, 300, 900] }), policy).action).toBe('done')
  })

  // ── permanent rejections ────────────────────────────────
  /**
   * Rejection has to be permanent for these, or the watcher re-reads the same
   * dead pool forever - 496 are created a day and the ones that will never
   * qualify are most of them.
   */
  it('rejects a pool with no WETH side, whichever slot it is in', () => {
    const other = '0x2222222222222222222222222222222222222222'
    expect(decidePool(pool({ token0: TOKEN, token1: other }), policy)).toEqual({
      action: 'reject',
      reason: 'not a WETH pair',
    })
  })

  it('accepts WETH as either token0 or token1', () => {
    expect(decidePool(pool({ token0: WETH, token1: TOKEN }), policy).action).toBe('create')
    expect(decidePool(pool({ token0: TOKEN, token1: WETH }), policy).action).toBe('create')
  })

  it('compares addresses without caring about checksum casing', () => {
    expect(decidePool(pool({ token1: WETH.toUpperCase() }), policy).action).toBe('create')
  })

  it('rejects a fee tier outside the whitelist', () => {
    // The 0.01% tier: 65 pools a day on this chain, none deeper than 10 ETH.
    const d = decidePool(pool({ fee: 100 }), policy)
    expect(d.action).toBe('reject')
    expect(d.reason).toMatch(/fee tier 100/)
  })

  // ── depth ───────────────────────────────────────────────
  /**
   * Deferred, not rejected: a pool that graduated thin at noon can be deep by
   * one, and the median graduated pool here holds 1.5 ETH.
   */
  it('defers a thin pool and says how thin', () => {
    const d = decidePool(pool({ wethDepthWei: 3n * 10n ** 18n }), policy)
    expect(d.action).toBe('defer')
    expect(d.reason).toBe('depth 3.000 ETH below keeper threshold 20.000 ETH')
  })

  it('accepts a pool exactly at the threshold', () => {
    expect(decidePool(pool({ wethDepthWei: policy.minDepthWei }), policy).action).toBe('create')
  })

  /**
   * The deferred set must be bounded or the watcher's per-tick work grows
   * without limit: at 292 WETH pools a day, re-checking everything ever seen
   * is thousands of reads a tick within a week.
   */
  it('gives up on a pool that has stayed thin past the age limit', () => {
    const d = decidePool(pool({ wethDepthWei: 1n * 10n ** 18n, ageSec: 25 * 3600 }), policy)
    expect(d.action).toBe('reject')
    expect(d.reason).toMatch(/25h old/)
  })

  it('still defers a thin pool that is only just too young to give up on', () => {
    expect(decidePool(pool({ wethDepthWei: 1n * 10n ** 18n, ageSec: 24 * 3600 }), policy).action).toBe('defer')
  })

  // ── the observation ring ────────────────────────────────
  it('pays to grow a ring that is too small', () => {
    const d = decidePool(pool({ cardinality: 1, cardinalityNext: 1 }), policy)
    expect(d.action).toBe('increaseCardinality')
    if (d.action === 'increaseCardinality') expect(d.target).toBe(300)
    expect(d.reason).toMatch(/cardinality 1 below 300/)
  })

  /**
   * The expensive mistake this exists to stop. Growing a ring is ~6.7M gas,
   * and Uniswap does not raise `cardinality` when you pay - it raises
   * `cardinalityNext` and moves the other on the pool's next write. A watcher
   * that only looked at `cardinality` would pay again every tick until
   * somebody happened to trade.
   */
  it('does not pay twice while a growth is pending', () => {
    const d = decidePool(pool({ cardinality: 1, cardinalityNext: 300 }), policy)
    expect(d.action).toBe('defer')
    expect(d.reason).toMatch(/waiting for a swap/)
  })

  it('does not pay again for a pool it has already paid for', () => {
    const d = decidePool(pool({ cardinality: 1, cardinalityNext: 1, cardinalityPaid: true }), policy)
    expect(d.action).toBe('defer')
    expect(d.reason).toMatch(/waiting for a swap/)
  })

  it('checks depth before spending on the ring', () => {
    // Thin AND no ring: the money must not be spent on a pool we would not
    // then create a market on.
    const d = decidePool(pool({ wethDepthWei: 1n * 10n ** 18n, cardinality: 1, cardinalityNext: 1 }), policy)
    expect(d.action).toBe('defer')
    expect(d.reason).toMatch(/depth/)
  })

  // ── history versus capacity ─────────────────────────────
  /**
   * A full ring says the slots exist, not that prices are in them. Creating a
   * market before the history exists produces one whose first settlements all
   * refund.
   */
  it('creates only the durations whose window the pool can already serve', () => {
    const d = decidePool(pool({ servableDurations: [60] }), policy)
    expect(d.action).toBe('create')
    if (d.action === 'create') expect(d.durations).toEqual([60])
  })

  it('defers when the ring is full but holds no usable history', () => {
    const d = decidePool(pool({ servableDurations: [] }), policy)
    expect(d.action).toBe('defer')
    expect(d.reason).toMatch(/no history yet for 60\/300\/900s/)
  })

  it('says done rather than defer when the servable set is empty but nothing is missing', () => {
    const d = decidePool(pool({ servableDurations: [], existingDurations: [60, 300, 900] }), policy)
    expect(d.action).toBe('done')
  })
})

describe('formatEth', () => {
  it('renders whole and milli-ether', () => {
    expect(formatEth(0n)).toBe('0.000 ETH')
    expect(formatEth(10n ** 18n)).toBe('1.000 ETH')
    expect(formatEth(4n * 10n ** 15n)).toBe('0.004 ETH') // MIN_BET
    expect(formatEth(12345n * 10n ** 15n)).toBe('12.345 ETH')
  })

  it('pads so 1.05 does not read as 1.5', () => {
    expect(formatEth(1_050n * 10n ** 15n)).toBe('1.050 ETH')
    expect(formatEth(1_005n * 10n ** 15n)).toBe('1.005 ETH')
  })
})
