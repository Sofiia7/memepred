import { describe, it, expect } from 'vitest'
import {
  resolveDeployment,
  parseNetwork,
  UnknownNetworkError,
  NETWORK_NAMES,
  robinhoodChain,
  robinhoodChainTestnet,
} from './chain'
import { base, baseSepolia } from 'wagmi/chains'

describe('resolveDeployment', () => {
  it('keeps mainnet meaning Base mainnet', () => {
    const d = resolveDeployment('mainnet')
    expect(d.chain).toBe(base)
    expect(d.currency.decimals).toBe(6)
    expect(d.currency.symbol).toBe('USDC')
    expect(d.poolBacked).toBe(false)
  })

  it('selects Base Sepolia only when asked for it by name', () => {
    expect(resolveDeployment('sepolia').chain).toBe(baseSepolia)
  })

  /**
   * Audit U11 (2026-09-28): anything that was not 'mainnet', 'rhc' or
   * 'rhc-testnet' used to select Base Sepolia, so a typo in a Robinhood
   * deployment's environment quietly put the site on the wrong chain with the
   * wrong currency. The value is a strict enum now; assertEnv() turns the
   * error into a fatal screen (see env.test.ts).
   */
  it('refuses anything that is not a member of the enum', () => {
    for (const v of [undefined, '', 'staging', 'BASE', 'testnet', 'rhc-mainnet', 'base sepolia']) {
      expect(() => resolveDeployment(v)).toThrow(UnknownNetworkError)
    }
  })

  it('names the accepted values in the error', () => {
    expect(() => resolveDeployment('staging')).toThrow(/mainnet, sepolia, rhc, rhc-testnet/)
    expect(() => resolveDeployment('staging')).toThrow(/staging/)
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

  /**
   * robinhoodchain.blockscout.com is mainnet 4663's explorer. Testnet 46630
   * has its own (docs/rhc/DEPLOYMENTS.md), and the two are not
   * interchangeable - an address that resolves on one 404s on the other.
   */
  it('points the testnet at its own explorer, not mainnet\'s', () => {
    expect(robinhoodChainTestnet.blockExplorers?.default.url).toBe(
      'https://explorer.testnet.chain.robinhood.com',
    )
    expect(robinhoodChainTestnet.blockExplorers?.default.url).not.toBe(
      robinhoodChain.blockExplorers?.default.url,
    )
  })

  it('ignores casing and surrounding whitespace', () => {
    expect(resolveDeployment('  RHC  ').chain).toBe(robinhoodChain)
    expect(resolveDeployment('Mainnet').chain).toBe(base)
  })

  it('forgives a BOM or a trailing newline pasted into the value', () => {
    expect(parseNetwork('\uFEFFrhc-testnet\n')).toBe('rhc-testnet')
  })
})

describe('parseNetwork', () => {
  it('returns the enum member, or undefined', () => {
    for (const n of NETWORK_NAMES) expect(parseNetwork(n)).toBe(n)
    expect(parseNetwork(undefined)).toBeUndefined()
    expect(parseNetwork(null)).toBeUndefined()
    expect(parseNetwork('')).toBeUndefined()
    expect(parseNetwork('ethereum')).toBeUndefined()
  })

  it('has exactly the four networks the app can be built for', () => {
    expect([...NETWORK_NAMES]).toEqual(['mainnet', 'sepolia', 'rhc', 'rhc-testnet'])
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

  it('matches PoolOrderbookMarket on rhc: 0.005 and 0.04 WETH', () => {
    const c = resolveDeployment('rhc').currency
    expect(c.minBet).toBe('0.005')
    expect(c.maxBet).toBe('0.04')
  })

  it('leaves room to show a stake at the floor', () => {
    // 0.005 needs three decimals; showing two would render the minimum bet
    // as 0.01, which is twice the floor.
    const c = resolveDeployment('rhc').currency
    expect(Number(c.minBet).toFixed(c.displayDecimals)).not.toBe('0.0000'.slice(0, c.displayDecimals + 2))
    expect(c.displayDecimals).toBeGreaterThanOrEqual(3)
  })
})
