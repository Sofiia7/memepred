import { describe, it, expect } from 'vitest'
import { resolveDeployment, robinhoodChain, robinhoodChainTestnet } from './chain'
import { base, baseSepolia } from 'wagmi/chains'

describe('resolveDeployment', () => {
  it('keeps mainnet meaning Base mainnet', () => {
    const d = resolveDeployment('mainnet')
    expect(d.chain).toBe(base)
    expect(d.currency.decimals).toBe(6)
    expect(d.currency.symbol).toBe('USDC')
    expect(d.poolBacked).toBe(false)
  })

  /**
   * The pre-existing behaviour: anything that was not the string 'mainnet'
   * selected Base Sepolia. Builds already in flight rely on it.
   */
  it('falls back to Base Sepolia for anything unrecognised', () => {
    for (const v of [undefined, '', 'staging', 'BASE', 'testnet']) {
      expect(resolveDeployment(v).chain).toBe(baseSepolia)
    }
  })

  it('selects Robinhood Chain and its currency', () => {
    const d = resolveDeployment('rhc')
    expect(d.chain).toBe(robinhoodChain)
    expect(d.chain.id).toBe(4663)
    expect(d.currency.decimals).toBe(18)
    expect(d.currency.symbol).toBe('WETH')
    expect(d.poolBacked).toBe(true)
  })

  it('selects the Robinhood testnet', () => {
    const d = resolveDeployment('rhc-testnet')
    expect(d.chain).toBe(robinhoodChainTestnet)
    expect(d.chain.id).toBe(46630)
    expect(d.chain.testnet).toBe(true)
  })

  it('ignores casing and surrounding whitespace', () => {
    expect(resolveDeployment('  RHC  ').chain).toBe(robinhoodChain)
    expect(resolveDeployment('Mainnet').chain).toBe(base)
  })
})

describe('stake bounds', () => {
  /**
   * These mirror the contracts' MIN_BET/MAX_BET, and RiskDisclosure prints the
   * ceiling to users as a promise about what they can lose. If a contract
   * constant moves and this does not, the disclosure becomes a false
   * statement - so the numbers are pinned here rather than only in prose.
   */
  it('matches OrderbookMarket on Base: 1 and 100 USDC', () => {
    const c = resolveDeployment('mainnet').currency
    expect(c.minBet).toBe('1')
    expect(c.maxBet).toBe('100')
  })

  it('matches PoolOrderbookMarket on rhc: 0.004 and 0.04 WETH', () => {
    const c = resolveDeployment('rhc').currency
    expect(c.minBet).toBe('0.004')
    expect(c.maxBet).toBe('0.04')
  })

  it('leaves room to show a stake at the floor', () => {
    // 0.004 needs three decimals; showing two would render the minimum bet
    // as 0.00.
    const c = resolveDeployment('rhc').currency
    expect(Number(c.minBet).toFixed(c.displayDecimals)).not.toBe('0.0000'.slice(0, c.displayDecimals + 2))
    expect(c.displayDecimals).toBeGreaterThanOrEqual(3)
  })
})
