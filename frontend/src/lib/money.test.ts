import { describe, it, expect } from 'vitest'
import { parseEther } from 'viem'
import { formatAmount } from './money'

describe('formatAmount', () => {
  it('trims trailing zeros', () => {
    expect(formatAmount(parseEther('0.5'))).toBe('0.5')
    expect(formatAmount(parseEther('1'))).toBe('1')
    expect(formatAmount(parseEther('0.00123'))).toBe('0.00123')
  })

  it('cuts to six decimals rather than printing all eighteen', () => {
    expect(formatAmount(123456789012345678n)).toBe('0.123456')
    expect(formatAmount(parseEther('12.3456789'))).toBe('12.345678')
  })

  it('shows zero as 0', () => {
    expect(formatAmount(0n)).toBe('0')
  })

  it('does not print a balance that is not zero as 0', () => {
    expect(formatAmount(1n)).toBe('<0.000001')
    expect(formatAmount(parseEther('0.0000004'))).toBe('<0.000001')
  })

  it('handles other decimals', () => {
    expect(formatAmount(2_500_000n, 6)).toBe('2.5')
    expect(formatAmount(5_000n, 6, 4)).toBe('0.005')
  })
})
