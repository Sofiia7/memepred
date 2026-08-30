import { describe, it, expect } from 'vitest'
import { BATCH_FROM_SELECTOR, codeHasSelector } from './resolverAbi.js'

/**
 * The keeper has to run against whichever resolver is actually deployed.
 *
 * resolveOrderbookMarketBatchFrom was added so a match that cannot settle stops
 * hiding the ones behind it, but the resolver live on Base Sepolia today
 * (0x08046A9F…) predates it: calling the new selector there reverts with no
 * data, because there is no such function and no fallback. Shipping the keeper
 * ahead of a contract redeploy would therefore stop settlement completely -
 * every settle reverting for the one reason the simulation guard reads as
 * "don't send".
 *
 * Contracts are meant to redeploy with the post-audit set, not before, so the
 * keeper detects what it is talking to instead of assuming.
 */
describe('codeHasSelector', () => {
  it('finds a selector a dispatcher pushes', () => {
    // How solc dispatches: PUSH4 <selector>, EQ, PUSH2 <dest>, JUMPI
    const code = `0x6080604052806380${BATCH_FROM_SELECTOR.slice(2)}1461003a57`
    expect(codeHasSelector(code, BATCH_FROM_SELECTOR)).toBe(true)
  })

  it('does not find one the contract does not implement', () => {
    expect(codeHasSelector('0x60806040526000803560e01c8063deadbeef14610010', BATCH_FROM_SELECTOR)).toBe(false)
  })

  it('is case-insensitive, since RPCs disagree about hex casing', () => {
    const code = `0x${BATCH_FROM_SELECTOR.slice(2).toUpperCase()}`
    expect(codeHasSelector(code, BATCH_FROM_SELECTOR)).toBe(true)
  })

  it('treats an address with no code as not supporting it', () => {
    expect(codeHasSelector('0x', BATCH_FROM_SELECTOR)).toBe(false)
    expect(codeHasSelector(undefined, BATCH_FROM_SELECTOR)).toBe(false)
  })

  it('pins the selector, so a signature change cannot pass unnoticed', () => {
    // keccak("resolveOrderbookMarketBatchFrom(address,uint256,uint256)")[0:4]
    expect(BATCH_FROM_SELECTOR).toBe('0xb29e7156')
  })
})
