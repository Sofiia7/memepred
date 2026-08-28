import { describe, it, expect, beforeEach } from 'vitest'
import { escalate, isStuckNonceError, NonceEscalation, shouldCancelNonce, CANCEL_AFTER_ESCALATIONS } from './feeEscalator.js'

const base = { maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n }

describe('recognising a wedged nonce', () => {
  /**
   * The exact string Base's RPC returned while the keeper sat stuck for over an
   * hour on 2026-08-28. viem buries it in `details` rather than `message`.
   */
  it('matches what Base actually said', () => {
    const err = Object.assign(new Error('Missing or invalid parameters.'), {
      details: 'replacement transaction underpriced',
    })
    expect(isStuckNonceError(err)).toBe(true)
  })

  it('matches the other two spellings RPCs use', () => {
    expect(isStuckNonceError(new Error('already known'))).toBe(true)
    expect(isStuckNonceError(new Error('transaction underpriced'))).toBe(true)
  })

  /**
   * These must NOT escalate. Paying more does not fix a revert or an empty
   * wallet, and bidding up on every error would drain the wallet faster during
   * exactly the failures where that matters most.
   */
  it('leaves unrelated failures alone', () => {
    expect(isStuckNonceError(new Error('insufficient funds for gas * price + value'))).toBe(false)
    expect(isStuckNonceError(new Error('execution reverted: not authorized'))).toBe(false)
    expect(isStuckNonceError(new Error('nonce too low'))).toBe(false)
    expect(isStuckNonceError(new Error('fetch failed'))).toBe(false)
  })
})

describe('escalate', () => {
  it('returns the quote untouched on a first attempt', () => {
    expect(escalate(base, 0)).toEqual(base)
  })

  /**
   * A replacement has to beat the stuck transaction by 10%. Anything at or
   * under that floor is rejected with the same error, forever.
   */
  it('clears the 10% replacement floor on every step', () => {
    let prev = base.maxFeePerGas
    for (let i = 1; i <= 5; i++) {
      const next = escalate(base, i).maxFeePerGas
      expect(Number(next) / Number(prev)).toBeGreaterThan(1.1)
      prev = next
    }
  })

  it('raises the priority fee too, not just the cap', () => {
    expect(escalate(base, 2).maxPriorityFeePerGas).toBe(1_562_500n)
  })

  it('compounds rather than adding', () => {
    expect(escalate(base, 3).maxFeePerGas).toBe(13_671_875n) // 7e6 * 1.25^3
  })
})

describe('NonceEscalation', () => {
  let e: NonceEscalation
  beforeEach(() => { e = new NonceEscalation() })

  it('bids the plain quote until something goes wrong', () => {
    expect(e.next(3980, base)).toEqual(base)
  })

  it('bids higher after each stuck-nonce failure at that nonce', () => {
    e.bump(3980)
    const once = e.next(3980, base).maxFeePerGas
    e.bump(3980)
    const twice = e.next(3980, base).maxFeePerGas

    expect(once).toBeGreaterThan(base.maxFeePerGas)
    expect(twice).toBeGreaterThan(once)
  })

  /**
   * A failure at a new nonce is a different problem - funds, a revert, a dead
   * RPC - and must not inherit a price inflated by an unrelated earlier
   * incident.
   */
  it('starts over at a different nonce', () => {
    e.bump(3980); e.bump(3980); e.bump(3980)
    expect(e.next(3981, base)).toEqual(base)
  })

  it('resets once a transaction gets through', () => {
    e.bump(3980); e.bump(3980)
    e.succeeded()
    expect(e.next(3980, base)).toEqual(base)
  })

  /**
   * Surfaced so the health probe can say "wedged nonce" instead of leaving the
   * operator to infer it from a keeper that has simply gone quiet. That
   * inference is what the August outage was made of.
   */
  it('reports which nonce is wedged, and stops once it is not', () => {
    expect(e.stuckNonce).toBeNull()
    e.bump(3980)
    expect(e.stuckNonce).toBe(3980)
    expect(e.level).toBe(1)
    e.succeeded()
    expect(e.stuckNonce).toBeNull()
  })
})

describe('when to stop bidding and just displace the nonce', () => {
  /**
   * Bidding up the real transaction has a floor the wallet can hit. Production
   * hit it: `have 72038606089498 want 127329237600000` - unaffordable only
   * because the bid carried an 800,000-gas limit. A 21,000-gas cancel at the
   * same fee costs ~40x less.
   */
  it('bids a few times before reaching for the cheap displacement', () => {
    expect(shouldCancelNonce(1)).toBe(false)
    expect(shouldCancelNonce(3)).toBe(false)
    expect(shouldCancelNonce(4)).toBe(true)
  })

  it('a 21k cancel outbids what an 800k transaction never could', () => {
    // The exact numbers production reported when the bid stopped being
    // affordable: 800,000 gas at 0.159 gwei against what the wallet held.
    const balance = 72_038_606_089_498n
    const fee     = 159_161_547n

    expect(800_000n * fee).toBeGreaterThan(balance)  // the real work: refused
    expect(21_000n  * fee).toBeLessThan(balance / 20n) // the cancel: pocket change
  })

  it('still bids the real transaction up first, while that is affordable', () => {
    const balance = 72_038_606_089_498n
    const fee     = escalate(base, CANCEL_AFTER_ESCALATIONS).maxFeePerGas

    // At the point it gives up bidding, the 800k transaction was still
    // affordable - the threshold is about diminishing returns, not only money.
    expect(800_000n * fee).toBeLessThan(balance)
  })
})
