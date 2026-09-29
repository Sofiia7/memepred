import { describe, it, expect, vi } from 'vitest'
import { resolveFactoryScope, andFactory, andMarketInFactory } from './marketScope'

const FACTORY = '0xC52b8b69d266F9656Be11511907192EaFD521BcB'
const LOWER = FACTORY.toLowerCase()

describe('resolveFactoryScope', () => {
  it('never scopes Base: its behaviour is what it always was', () => {
    expect(resolveFactoryScope('base', FACTORY)).toBeNull()
    expect(resolveFactoryScope('base', undefined)).toBeNull()
  })

  it('scopes rhc to the configured factory, lower-cased', () => {
    expect(resolveFactoryScope('rhc', FACTORY)).toBe(LOWER)
    expect(resolveFactoryScope('rhc', `  ${FACTORY}  `)).toBe(LOWER)
  })

  it('fails open, loudly and once, when the factory is unset or is not an address', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveFactoryScope('rhc', undefined)).toBeNull()
    expect(resolveFactoryScope('rhc', '0x')).toBeNull()
    expect(resolveFactoryScope('rhc', '')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('never lets anything but a plain address reach SQL', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveFactoryScope('rhc', "0x'; DROP TABLE markets; --")).toBeNull()
    expect(resolveFactoryScope('rhc', LOWER + "' OR '1'='1")).toBeNull()
    expect(resolveFactoryScope('rhc', '0x' + 'g'.repeat(40))).toBeNull()
    expect(resolveFactoryScope('rhc', LOWER.slice(0, -1))).toBeNull()
    vi.restoreAllMocks()
  })
})

describe('andFactory', () => {
  it('adds nothing when there is no scope, so every Base query keeps its exact text', () => {
    expect(andFactory('m.factory_address', null)).toBe('')
  })

  it('adds one equality on the factory column, with the address inlined', () => {
    expect(andFactory('m.factory_address', LOWER)).toBe(` AND m.factory_address = '${LOWER}'`)
    expect(andFactory('factory_address', LOWER)).toBe(` AND factory_address = '${LOWER}'`)
  })

  it('refuses a column name that is not a plain identifier', () => {
    expect(() => andFactory('1; DROP TABLE markets', LOWER)).toThrow(/not a plain column name/)
    expect(() => andFactory("m.factory_address' OR '1", LOWER)).toThrow()
  })
})

describe('andMarketInFactory', () => {
  it('adds nothing when there is no scope', () => {
    expect(andMarketInFactory('mt.market_address', null)).toBe('')
  })

  it('scopes a table that only knows a market by address through the markets table', () => {
    expect(andMarketInFactory('mt.market_address', LOWER)).toBe(
      ` AND mt.market_address IN (SELECT market_address FROM markets WHERE factory_address = '${LOWER}')`,
    )
  })
})
