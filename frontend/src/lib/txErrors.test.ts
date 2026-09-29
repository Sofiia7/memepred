// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { explainTxError, isUserRejection } from './txErrors'

describe('isUserRejection', () => {
  it('recognises the ways a wallet says "no"', () => {
    expect(isUserRejection({ code: 4001 })).toBe(true)
    expect(isUserRejection({ name: 'UserRejectedRequestError' })).toBe(true)
    expect(isUserRejection({ shortMessage: 'User rejected the request.' })).toBe(true)
    expect(isUserRejection({ message: 'MetaMask Tx Signature: User denied transaction signature.' })).toBe(true)
  })

  it('does not mistake a revert for a refusal', () => {
    expect(
      isUserRejection({ shortMessage: 'The contract function "claim" reverted with the following reason:\nnot your order' }),
    ).toBe(false)
    expect(isUserRejection(undefined)).toBe(false)
    expect(isUserRejection(null)).toBe(false)
  })
})

describe('explainTxError', () => {
  const reverted = (fn: string, reason: string) => ({
    shortMessage: `The contract function "${fn}" reverted with the following reason:\n${reason}`,
    message: `${fn} reverted\n\nContract Call:\n  address: 0x...`,
  })

  it('says a rejected signature sent nothing', () => {
    expect(explainTxError({ code: 4001 })).toBe('Cancelled in your wallet - nothing was sent.')
  })

  it.each([
    ['cancelOrder', 'not your order', /Only the wallet that placed this order/],
    ['cancelOrder', 'already refunded', /already returned/],
    ['cancelOrder', 'wrong status', /no longer open/],
    ['cancelOrder', 'nothing to refund', /whole order was matched/],
    ['refundExpired', 'not expired', /Cancel the order to get the stake back now/],
    ['claim', 'settlements pending', /still waiting for a result/],
    ['claim', 'already claimed', /already claimed/],
    ['claim', 'not settled', /cancel the remainder first/],
    ['claim', 'nothing to claim', /nothing to claim/],
    ['emergencyRefundMatch', 'already settled', /already been settled/],
    ['emergencyRefundMatch', 'grace not over', /24 hours after the settlement time/],
    ['emergencyRefundMatch', 'match not found', /does not exist/],
  ])('%s reverting "%s" reads as plain English', (fn, reason, expected) => {
    expect(explainTxError(reverted(fn, reason))).toMatch(expected)
  })

  it('does not confuse "not settled" with "already settled"', () => {
    expect(explainTxError({ shortMessage: 'reverted: already settled' })).toMatch(/already been settled/)
    expect(explainTxError({ shortMessage: 'reverted: not settled' })).toMatch(/not ready to claim/)
  })

  it('returns an unknown message as is, but never a page of it', () => {
    expect(explainTxError({ shortMessage: 'HTTP request failed.' })).toBe('HTTP request failed.')
    const long = 'x'.repeat(1000)
    const out = explainTxError({ message: long })
    expect(out.length).toBeLessThanOrEqual(240)
    expect(out.endsWith('...')).toBe(true)
  })

  it('falls back to the given text when there is nothing to say', () => {
    expect(explainTxError({}, 'Claim failed.')).toBe('Claim failed.')
    expect(explainTxError(undefined)).toBe('The transaction failed.')
  })
})
