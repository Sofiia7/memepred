import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { getAddress } from 'viem'
import { readRoundsConfig, roundsEnabled } from './config.js'

const ADDR = getAddress('0x5b0e7a1d2c3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b')

describe('the switch', () => {
  it('is off unless ROUNDS_ENABLED is exactly "true"', () => {
    expect(roundsEnabled({})).toBe(false)
    expect(roundsEnabled({ ROUNDS_ADDRESS: ADDR })).toBe(false)
    for (const v of ['', 'false', '1', 'yes', 'TRUE', 'True', 'on']) {
      expect(roundsEnabled({ ROUNDS_ENABLED: v }), v).toBe(false)
    }
    expect(roundsEnabled({ ROUNDS_ENABLED: 'true' })).toBe(true)
    expect(roundsEnabled({ ROUNDS_ENABLED: ' true ' })).toBe(true)
  })

  it('reads as off, with no error, when nothing about rounds is set', () => {
    expect(readRoundsConfig({})).toEqual({ enabled: false })
    // An address alone does not switch it on.
    expect(readRoundsConfig({ ROUNDS_ADDRESS: ADDR })).toEqual({ enabled: false })
  })

  it('stays off, with the reason, when switched on without a usable address', () => {
    expect(readRoundsConfig({ ROUNDS_ENABLED: 'true' })).toEqual({ enabled: false, error: 'ROUNDS_ADDRESS is not set' })
    const r = readRoundsConfig({ ROUNDS_ENABLED: 'true', ROUNDS_ADDRESS: '0x1234' })
    expect(r.enabled).toBe(false)
    expect((r as { error: string }).error).toMatch(/not an address/)
  })

  it('is on with an address, and the defaults are the documented ones', () => {
    const r = readRoundsConfig({ ROUNDS_ENABLED: 'true', ROUNDS_ADDRESS: ADDR.toLowerCase() })
    expect(r.enabled).toBe(true)
    if (!r.enabled) return
    expect(r.config).toEqual({
      deployment: { address: ADDR, startBlock: null },
      intervalMs: 5_000,
      logChunk: 100_000n,
      logOverlap: 200n,
      lookbackBlocks: 1_200_000n,
      maxChunksPerTick: 20,
      confirmations: 0n,
      graceReserveBps: 2_000n,
      l1ReserveWei: 0n,
      feesWithdrawMinWei: 10n ** 16n,
      receiptTimeoutMs: 20_000,
      maxTxPerTick: 20,
      poolCheckSec: 300,
      delistDailyBudgetWei: 10n ** 15n,
    })
  })
})

describe('knobs', () => {
  const on = { ROUNDS_ENABLED: 'true', ROUNDS_ADDRESS: ADDR }

  it('takes valid overrides', () => {
    const r = readRoundsConfig({
      ...on,
      ROUNDS_START_BLOCK: '777',
      ROUNDS_INTERVAL_MS: '5000',
      ROUNDS_LOG_CHUNK_BLOCKS: '50000',
      ROUNDS_GRACE_RESERVE_BPS: '1000',
      ROUNDS_FEES_WITHDRAW_MIN_ETH: '0.25',
      ROUNDS_MAX_TX_PER_TICK: '3',
    })
    if (!r.enabled) throw new Error('expected enabled')
    expect(r.config.deployment.startBlock).toBe(777n)
    expect(r.config.intervalMs).toBe(5000)
    expect(r.config.logChunk).toBe(50_000n)
    expect(r.config.graceReserveBps).toBe(1_000n)
    expect(r.config.feesWithdrawMinWei).toBe(25n * 10n ** 16n)
    expect(r.config.maxTxPerTick).toBe(3)
  })

  it('falls back, loudly, on a value that would turn a typo into a hot loop or no reserve at all', () => {
    const warn = vi.fn()
    const r = readRoundsConfig({
      ...on,
      ROUNDS_LOG_CHUNK_BLOCKS: '0',
      ROUNDS_GRACE_RESERVE_BPS: '9500',
      ROUNDS_MAX_TX_PER_TICK: '-1',
      ROUNDS_FEES_WITHDRAW_MIN_ETH: 'a lot',
      ROUNDS_RECEIPT_TIMEOUT_MS: '120000',
    }, warn)
    if (!r.enabled) throw new Error('expected enabled')
    expect(r.config.logChunk).toBe(100_000n)
    expect(r.config.graceReserveBps).toBe(2_000n)
    expect(r.config.maxTxPerTick).toBe(20)
    expect(r.config.feesWithdrawMinWei).toBe(10n ** 16n)
    expect(r.config.receiptTimeoutMs).toBe(20_000)
    expect(warn).toHaveBeenCalledTimes(5)
  })

  /**
   * The poll is what the hard deadlines stand on (fixStrike within 119 s of
   * strikeEnd, settle within 359 s of settleAt), so it is not quietly replaced:
   * outside 1-10 s the rounds keeper refuses to start and says why.
   */
  it('refuses to start on a poll outside 1-10 s, with the reason', () => {
    for (const bad of ['15000', '30000', '999', '0', '15s', '5000.5', '-5000']) {
      const r = readRoundsConfig({ ...on, ROUNDS_INTERVAL_MS: bad })
      expect(r.enabled, bad).toBe(false)
      expect((r as { error: string }).error, bad).toMatch(/ROUNDS_INTERVAL_MS=.* is outside 1000-10000 ms/)
    }
    for (const good of ['1000', '5000', '10000']) {
      const r = readRoundsConfig({ ...on, ROUNDS_INTERVAL_MS: good })
      expect(r.enabled && r.config.intervalMs, good).toBe(Number(good))
    }
  })

  it('can switch automatic delisting off and set its daily budget', () => {
    expect(readRoundsConfig({ ...on, ROUNDS_DELIST_DAILY_BUDGET_ETH: 'off' }).enabled && (readRoundsConfig({ ...on, ROUNDS_DELIST_DAILY_BUDGET_ETH: 'off' }) as any).config.delistDailyBudgetWei).toBeNull()
    const r = readRoundsConfig({ ...on, ROUNDS_DELIST_DAILY_BUDGET_ETH: '0.005', ROUNDS_POOL_CHECK_SEC: '60' })
    expect(r.enabled && r.config.delistDailyBudgetWei).toBe(5n * 10n ** 15n)
    expect(r.enabled && r.config.poolCheckSec).toBe(60)
  })

  it('can switch fee withdrawal off, and never uses a zero threshold', () => {
    const off = readRoundsConfig({ ...on, ROUNDS_FEES_WITHDRAW_MIN_ETH: 'off' })
    expect(off.enabled && off.config.feesWithdrawMinWei).toBeNull()
    const zero = readRoundsConfig({ ...on, ROUNDS_FEES_WITHDRAW_MIN_ETH: '0' })
    expect(zero.enabled && zero.config.feesWithdrawMinWei).toBe(1n)
  })
})

/**
 * The keeper of the existing markets must not change by a byte while rounds
 * are off. keeper/index.ts cannot be imported by a test (it connects and starts
 * loops at the top level), so this reads it: the only static import from the
 * rounds module is the pure switch, and the rest is loaded behind it.
 */
describe('wiring in keeper/index.ts', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(resolve(here, '../keeper/index.ts'), 'utf8')

  it('imports only the switch statically', () => {
    const staticRounds = [...src.matchAll(/^import .* from '\.\.\/rounds\/([^']+)'/gm)].map((m) => m[1])
    expect(staticRounds).toEqual(['config.js'])
  })

  it('loads and starts the rounds keeper only behind roundsEnabled()', () => {
    const lines = src.split('\n').filter((l) => l.includes("import('../rounds/"))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\s*if \(roundsEnabled\(\)\) await \(await import\('\.\.\/rounds\/index\.js'\)\)\.startRoundsKeeper\(start\)\s*$/)
  })
})
