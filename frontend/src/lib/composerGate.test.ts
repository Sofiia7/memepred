import { describe, it, expect } from 'vitest'
import { composerGate, priceLabel, type GateInput } from './composerGate'

/**
 * The Composer's main button: what it says and whether it may be pressed.
 * Audit U02 and U03 are the point of most of these: a price that is loading,
 * failed, or old, and a fee that has not been read yet, must each keep the
 * button off - it used to be enabled with a zero price and a "0.00%" fee.
 */

const ok: GateInput = {
  isConnected: true,
  busy: false,
  step: 'idle',
  stakeOk: true,
  insufficientBalance: false,
  price: { status: 'live', raw: 10n ** 18n },
  feeReady: true,
  feeFailed: false,
  deploymentMismatch: false,
  symbol: 'WETH',
  side: 'up',
  stake: 0.01,
}
const gate = (over: Partial<GateInput> = {}) => composerGate({ ...ok, ...over })

describe('composerGate, the ordinary case', () => {
  it('is enabled and says what pressing it does', () => {
    expect(gate()).toEqual({ disabled: false, label: 'BUY UP · 0.01 WETH', reason: undefined })
    expect(gate({ side: 'down', stake: 0.04 }).label).toBe('BUY DOWN · 0.04 WETH')
  })

  it('is disabled for a stake outside the limits', () => {
    const g = gate({ stakeOk: false })
    expect(g.disabled).toBe(true)
    expect(g.reason).toBe('stake')
  })
})

describe('composerGate, price (audit U02)', () => {
  it.each([
    ['loading', 'PRICE LOADING…'],
    ['idle', 'PRICE LOADING…'],
    ['unavailable', 'PRICE UNAVAILABLE - RETRYING'],
    ['stale', 'PRICE STALE - WAITING FOR A FRESH ONE'],
  ] as const)('is disabled while the price is %s', (status, label) => {
    const g = gate({ price: { status, raw: status === 'stale' ? 10n ** 18n : 0n } })
    expect(g).toEqual({ disabled: true, label, reason: 'price' })
  })

  it('is disabled for a zero price even if something says it is live', () => {
    const g = gate({ price: { status: 'live', raw: 0n } })
    expect(g.disabled).toBe(true)
    expect(g.reason).toBe('price')
  })

  it('has one label per state and none for live', () => {
    expect(priceLabel('live')).toBeNull()
    for (const s of ['loading', 'idle', 'unavailable', 'stale'] as const) expect(priceLabel(s)).toBeTruthy()
  })
})

describe('composerGate, fee (audit U03)', () => {
  it('is disabled while the fee has not been read', () => {
    expect(gate({ feeReady: false })).toEqual({ disabled: true, label: 'FEE LOADING…', reason: 'fee' })
  })

  it('says so when the fee read failed', () => {
    expect(gate({ feeReady: false, feeFailed: true })).toEqual({ disabled: true, label: 'FEE UNAVAILABLE - RETRYING', reason: 'fee' })
  })

  it('treats a fee of zero, once read, as a fee', () => {
    // feeReady is about having read it, not about it being non-zero.
    expect(gate({ feeReady: true }).disabled).toBe(false)
  })
})

describe('composerGate, everything else that keeps it off', () => {
  it('a deployment mismatch refuses first, ahead of everything', () => {
    const g = gate({ deploymentMismatch: true, insufficientBalance: true, price: { status: 'loading', raw: 0n } })
    expect(g).toEqual({ disabled: true, label: 'WRONG DEPLOYMENT - SIGNING OFF', reason: 'deployment' })
  })

  it('shows the step while a bet is being placed', () => {
    expect(gate({ busy: true, step: 'approving' })).toMatchObject({ disabled: true, label: 'APPROVING WETH…', reason: 'busy' })
    expect(gate({ busy: true, step: 'betting' })).toMatchObject({ disabled: true, label: 'PLACING BET…', reason: 'busy' })
  })

  it('stays off between the receipt and the redirect, so PLACED cannot be pressed into a second bet', () => {
    expect(gate({ step: 'confirmed' })).toMatchObject({ disabled: true, label: 'PLACED ✓', reason: 'placed' })
  })

  it('is off while a wrap (or anything else) holds the wallet', () => {
    expect(gate({ busy: true }).disabled).toBe(true)
  })

  it('points at wrapping when the wallet holds too little of the stake token', () => {
    expect(gate({ insufficientBalance: true })).toEqual({ disabled: true, label: 'INSUFFICIENT WETH - WRAP ETH FIRST', reason: 'balance' })
  })

  it('offers a retry with the reason after a failed attempt', () => {
    const g = gate({ step: 'error', errorText: 'The price moved before this confirmed - try again.' })
    expect(g.disabled).toBe(false)
    expect(g.label).toBe('RETRY · The price moved before this confirmed - try again.')
  })

  it('does not offer a retry against a price it does not have', () => {
    const g = gate({ step: 'error', errorText: 'x', price: { status: 'stale', raw: 10n ** 18n } })
    expect(g.disabled).toBe(true)
    expect(g.reason).toBe('price')
  })
})

describe('composerGate, not connected', () => {
  it('always offers to connect, whatever else is not ready yet', () => {
    const g = gate({ isConnected: false, price: { status: 'loading', raw: 0n }, feeReady: false, stakeOk: false })
    expect(g).toEqual({ disabled: false, label: 'CONNECT WALLET', reason: undefined })
  })
})
