import { describe, it, expect } from 'vitest'
import { clockOffset } from './useChainClock'
import { ROUNDS_ENABLED } from './flag'

describe('clockOffset', () => {
  it('moves a slow local clock forward to the chain', () => {
    expect(clockOffset(1_000, 990.4)).toBe(9)
  })

  it('never moves the clock back for a quiet chain whose last block is old', () => {
    expect(clockOffset(900, 1_000)).toBe(0)
    expect(clockOffset(1_000, 1_000)).toBe(0)
  })
})

describe('the feature flag', () => {
  it('is off in a build that does not set VITE_ROUNDS_ENABLED', () => {
    expect(import.meta.env.VITE_ROUNDS_ENABLED).toBeUndefined()
    expect(ROUNDS_ENABLED).toBe(false)
  })
})
