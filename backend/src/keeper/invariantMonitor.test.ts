import { describe, it, expect } from 'vitest'
import { classifyDrift, finite } from './invariantMonitor'

// The thresholds the rhc profile uses: one MIN_BET and ten of them.
const WARN = 0.005
const CRIT = 0.05

describe('classifyDrift', () => {
  it('calls a matching balance ok', () => {
    expect(classifyDrift(0, WARN, CRIT)).toBe('ok')
  })

  it('leaves rounding below the warn threshold alone', () => {
    expect(classifyDrift(0.004, WARN, CRIT)).toBe('ok')
    expect(classifyDrift(WARN, WARN, CRIT)).toBe('ok')
  })

  it('warns once the drift passes a single stake', () => {
    expect(classifyDrift(0.006, WARN, CRIT)).toBe('warn')
    expect(classifyDrift(CRIT, WARN, CRIT)).toBe('warn')
  })

  it('goes critical past ten stakes', () => {
    expect(classifyDrift(0.051, WARN, CRIT)).toBe('critical')
    expect(classifyDrift(45_000_000_000, WARN, CRIT)).toBe('critical')
  })

  // The regression this function was extracted for. `NaN > crit` and
  // `NaN > warn` are both false, so an if/else-if chain reports "ok" - which is
  // what put five NaN snapshots in the table labelled as healthy.
  it('does not report ok when the drift cannot be computed', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(classifyDrift(bad, WARN, CRIT)).toBe('critical')
    }
  })

  it('is not fooled by a NaN that came from parsing a NULL sum', () => {
    const expected = parseFloat(null as unknown as string) // what the view returns for an empty book
    expect(Number.isNaN(expected)).toBe(true)
    expect(classifyDrift(Math.abs(0 - expected), WARN, CRIT)).toBe('critical')
  })
})

describe('finite', () => {
  it('passes real numbers through', () => {
    expect(finite(0)).toBe(0)
    expect(finite(-1.5)).toBe(-1.5)
  })

  // Stored as NaN, a single row makes max(abs(drift_usdc)) over the whole
  // history return NaN, which is how these rows were found in the first place.
  it('stores nothing rather than a NaN that would poison the aggregates', () => {
    expect(finite(NaN)).toBeNull()
    expect(finite(Infinity)).toBeNull()
  })
})
