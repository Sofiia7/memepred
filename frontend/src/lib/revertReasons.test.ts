import { describe, it, expect } from 'vitest'
import { friendlyRevertReason } from './revertReasons'

describe('friendlyRevertReason', () => {
  it('maps a known contract revert reason to short plain English', () => {
    expect(friendlyRevertReason('price slippage exceeded')).toBe(
      'The price moved before this confirmed - try again.',
    )
  })

  /**
   * Real errors from wagmi/viem wrap the bare require() string in a lot of
   * extra text (which function reverted, on which contract, a stack of
   * "Raw Call Arguments" and so on). The match has to survive that, since
   * this is the shape callers actually see - not the bare string alone.
   */
  it('matches a known reason even wrapped in the rest of a real viem error', () => {
    const wrapped =
      'The contract function "placeBet" reverted with the following reason:\nexpectedPrice zero\n\nContract Call:\n  address: 0x...'
    expect(friendlyRevertReason(wrapped)).toBe("Price hasn't loaded yet - try again.")
  })

  /**
   * The bug this exists to fix: a ~30-char slice rendered "price slippage
   * exceeded", "expectedPrice zero" and an ERC20 balance error as the same
   * unhelpful truncated prefix. Anything not in the known-reasons map must
   * come back in FULL, not truncated, so at least it's readable even when it
   * isn't friendly.
   */
  it('returns an unmapped message in full, not truncated', () => {
    const unmapped = 'ERC20: transfer amount exceeds balance, which is a message longer than thirty characters'
    expect(friendlyRevertReason(unmapped)).toBe(unmapped)
  })

  it('returns an empty string for no message rather than throwing', () => {
    expect(friendlyRevertReason(undefined)).toBe('')
  })
})
