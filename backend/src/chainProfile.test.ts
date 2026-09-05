import { describe, it, expect } from 'vitest'
import { resolveChainProfile, robinhoodChain, robinhoodChainTestnet } from './chainProfile.js'

describe('resolveChainProfile', () => {
  it('defaults to base, so an unset variable changes nothing', () => {
    const p = resolveChainProfile(undefined)
    expect(p.name).toBe('base')
    expect(p.currencyDecimals).toBe(6)
    expect(p.pushesPricesOnChain).toBe(true)
    expect(p.rollsOverMarkets).toBe(true)
    expect(p.watchesPools).toBe(false)
    expect(p.usesArbGasInfo).toBe(false)
  })

  it('describes rhc as the chain measurements say it behaves', () => {
    const p = resolveChainProfile('rhc')
    expect(p.name).toBe('rhc')
    expect(p.currencyDecimals).toBe(18)
    expect(p.currencySymbol).toBe('WETH')
    // No price pushes: the pool keeps its own observation history.
    expect(p.pushesPricesOnChain).toBe(false)
    // No rollover: a market has no close time, so it lives forever.
    expect(p.rollsOverMarkets).toBe(false)
    expect(p.watchesPools).toBe(true)
    // eth_gasPrice under-reports by ~4x here; ArbGasInfo is the real price.
    expect(p.usesArbGasInfo).toBe(true)
  })

  it('accepts surrounding whitespace and any casing', () => {
    expect(resolveChainProfile('  RHC \n').name).toBe('rhc')
    expect(resolveChainProfile('Base').name).toBe('base')
  })

  /**
   * The failure this guards against is silent: a typo that fell back to `base`
   * would point a Robinhood Chain deployment at a RedStone price recorder and
   * a rollover loop, and the first symptom would be the gas bill.
   */
  it('throws on anything else rather than falling back', () => {
    expect(() => resolveChainProfile('robinhood')).toThrow(/CHAIN_PROFILE/)
    expect(() => resolveChainProfile('')).toThrow(/CHAIN_PROFILE/)
    expect(() => resolveChainProfile('rhc ; base')).toThrow(/CHAIN_PROFILE/)
  })
})

describe('robinhood chain definitions', () => {
  it('carries the ids the RPCs actually report', () => {
    // Verified live: eth_chainId returned 0x1237 and 0xb626.
    expect(robinhoodChain.id).toBe(0x1237)
    expect(robinhoodChainTestnet.id).toBe(0xb626)
    expect(robinhoodChainTestnet.testnet).toBe(true)
  })

  it('stakes in ETH, because there is no native USDC on this chain', () => {
    expect(robinhoodChain.nativeCurrency.decimals).toBe(18)
    expect(robinhoodChain.nativeCurrency.symbol).toBe('ETH')
  })
})
