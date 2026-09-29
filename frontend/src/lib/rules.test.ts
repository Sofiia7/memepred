import { describe, it, expect } from 'vitest'
import { parseEther } from 'viem'
import {
  preSignRules,
  MATCH_TIMEOUT_MIN,
  ENTRY_TWAP_SEC,
  PRICE_JUMP_REFUND_PCT,
  REFUND_GRACE_HOURS,
  RESULT_DELAY_HINT_SEC,
  DEFAULT_SLIPPAGE_BPS,
  GAS_RESERVE_ETH,
  GAS_RESERVE_WEI,
} from './rules'

/**
 * These numbers are printed to users as promises about what will happen to
 * their money, and each mirrors a contract constant. They are pinned here so a
 * change on one side has to be a change on the other.
 */
describe('rules constants mirror the contracts', () => {
  it('matches OrderbookMarket.MATCH_TIMEOUT (5 minutes) and PoolOracleResolver (60s entry TWAP, 2% guard, 24h grace)', () => {
    expect(MATCH_TIMEOUT_MIN).toBe(5)
    expect(ENTRY_TWAP_SEC).toBe(60)
    expect(PRICE_JUMP_REFUND_PCT).toBe(2) // MAX_SPREAD_BPS = 200
    expect(REFUND_GRACE_HOURS).toBe(24) // SETTLE_GRACE
    expect(RESULT_DELAY_HINT_SEC).toBe(60)
  })

  it('reserves 0.0005 ETH for gas, in both units', () => {
    expect(GAS_RESERVE_ETH).toBe('0.0005')
    expect(GAS_RESERVE_WEI).toBe(parseEther(GAS_RESERVE_ETH))
  })
})

describe('preSignRules', () => {
  const rules = preSignRules({ durationSec: 300 })
  const all = rules.map((r) => `${r.title}. ${r.text}`).join('\n')

  it('is about five points, each with a title and a sentence', () => {
    expect(rules).toHaveLength(5)
    for (const r of rules) {
      expect(r.title.length).toBeGreaterThan(3)
      expect(r.text.length).toBeGreaterThan(20)
    }
    expect(new Set(rules.map((r) => r.id)).size).toBe(5)
  })

  it('says who you trade against: another trader or, where enabled, the LP vault, in parts', () => {
    expect(all).toMatch(/another trader/)
    expect(all).toMatch(/LP vault/)
    expect(all).toMatch(/where it is enabled/)
    expect(all).toMatch(/filled in parts/)
  })

  it('says what happens to what is not matched: 5 minutes, then refunded, cancellable any time', () => {
    expect(all).toMatch(/within 5 minutes/)
    expect(all).toMatch(/unmatched part is refunded/)
    expect(all).toMatch(/cancel it any time/)
  })

  it('says entry is the 60 second TWAP when matched and exit is the average when the window ends', () => {
    expect(all).toMatch(/60 second average price \(TWAP\) when you are matched/)
    expect(all).toMatch(/Exit is its average when your 5m window ends/)
  })

  it('names the window the market actually has', () => {
    expect(preSignRules({ durationSec: 900 }).map((r) => r.text).join(' ')).toMatch(/your 15m window/)
    expect(preSignRules({ durationSec: 60 }).map((r) => r.text).join(' ')).toMatch(/your 1m window/)
  })

  it('says a resting order that leaves its price band is dropped and can be cancelled or refunded', () => {
    expect(all).toMatch(/1% price band you chose/)
    expect(all).toMatch(/dropped from the queue/)
    expect(all).toMatch(/cancelled or refunded/)
    expect(preSignRules({ durationSec: 300, slippageBps: DEFAULT_SLIPPAGE_BPS * 2 }).map((r) => r.text).join(' ')).toMatch(/2% price band/)
  })

  it('says a price jump above 2% or a pool with no history refunds both stakes at once, with no fee', () => {
    expect(all).toMatch(/jumps more than 2% at the end of the window/)
    expect(all).toMatch(/no price history/)
    expect(all).toMatch(/both stakes are refunded immediately with no fee/)
  })

  it('does not promise the result at the exact moment the window ends', () => {
    expect(all).toMatch(/normally arrives within about a minute after the window ends/)
    expect(all).not.toMatch(/exactly/i)
    expect(all).not.toMatch(/guarantee/i)
  })

  it('no longer claims a jump is retried until the price calms down', () => {
    expect(all).not.toMatch(/retried/)
    expect(all).not.toMatch(/calm/)
  })

  it('does not use the misleading "waits for an opposite order"', () => {
    expect(all).not.toMatch(/opposite order/)
  })

  it('contains no long dashes', () => {
    for (const dash of [String.fromCharCode(0x2013), String.fromCharCode(0x2014)]) {
      expect(all).not.toContain(dash)
    }
  })
})
