// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getAddress } from 'viem'
import { parseMarketParam, parseOrderIdParam } from './routeParams'

const LOWER = '0x52908400098527886e0f7030069857d2e4169ee7'
const CHECKSUMMED = getAddress(LOWER)

describe('parseMarketParam', () => {
  it('accepts the all-lowercase form the API serves', () => {
    expect(parseMarketParam(LOWER)).toBe(LOWER)
  })

  it('accepts a correctly checksummed address', () => {
    expect(CHECKSUMMED).not.toBe(LOWER) // the fixture must actually be mixed case
    expect(parseMarketParam(CHECKSUMMED)).toBe(CHECKSUMMED)
  })

  it('rejects a mixed-case address whose checksum is wrong (the usual typo)', () => {
    // Flip the case of the first letter: the address stays mixed case (it has
    // several uppercase letters) but no longer matches its own checksum.
    const i = CHECKSUMMED.slice(2).search(/[a-fA-F]/) + 2
    const c = CHECKSUMMED[i]
    const flipped =
      CHECKSUMMED.slice(0, i) + (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) + CHECKSUMMED.slice(i + 1)
    expect(flipped).not.toBe(CHECKSUMMED)
    expect(flipped).not.toBe(flipped.toLowerCase())
    expect(parseMarketParam(flipped)).toBeNull()
  })

  it('rejects anything that is not 0x plus 40 hex characters', () => {
    expect(parseMarketParam(undefined)).toBeNull()
    expect(parseMarketParam('')).toBeNull()
    expect(parseMarketParam('abc')).toBeNull()
    expect(parseMarketParam('0x1234')).toBeNull()
    expect(parseMarketParam(LOWER + '00')).toBeNull()
    expect(parseMarketParam('0x' + 'g'.repeat(40))).toBeNull()
    expect(parseMarketParam(LOWER.slice(2))).toBeNull() // no 0x prefix
  })

  it('rejects the zero address, which is what an unset value looks like', () => {
    expect(parseMarketParam('0x0000000000000000000000000000000000000000')).toBeNull()
  })
})

describe('parseOrderIdParam', () => {
  it('accepts a positive decimal integer', () => {
    expect(parseOrderIdParam('1')).toBe(1n)
    expect(parseOrderIdParam('42')).toBe(42n)
    expect(parseOrderIdParam('18446744073709551617')).toBe(18446744073709551617n)
  })

  it('rejects zero, negatives, decimals, hex and junk', () => {
    for (const bad of [undefined, '', '0', '00', '-1', '1.5', '0x10', ' 1', '1 ', '1e3', 'abc', '١٢']) {
      expect(parseOrderIdParam(bad as string | undefined)).toBeNull()
    }
  })
})
