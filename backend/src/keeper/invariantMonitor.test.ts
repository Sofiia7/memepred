import { describe, it, expect } from 'vitest'
import { classifyDrift, projectionIsReadable, sumBalances, nextUnmeasured } from './invariantMonitor'

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

describe('projectionIsReadable', () => {
  it('accepts a projection of real numbers, an empty book included', () => {
    expect(projectionIsReadable([0, 0, 0, 0])).toBe(true)
    expect(projectionIsReadable([5.155, 1.32, 3.64, 0.195])).toBe(true)
  })

  // What replaced `finite`, which mapped NaN to NULL for columns that are all
  // NOT NULL: the insert threw, and the alarm it was meant to carry never went up.
  it('refuses a projection containing anything that is not a number', () => {
    expect(projectionIsReadable([1, NaN, 2, 3])).toBe(false)
    expect(projectionIsReadable([1, 2, 3, Infinity])).toBe(false)
  })
})

describe('sumBalances', () => {
  const book: Record<string, bigint> = { a: 5n, b: 7n, c: 11n }
  const timeout = () => new Error('The request took too long to respond.')

  it('sums every market that answers', async () => {
    expect(await sumBalances(Object.keys(book), async (m) => book[m])).toEqual({ totalWei: 23n, unread: [] })
  })

  it('recovers a read that times out once', async () => {
    let tries = 0
    const r = await sumBalances(Object.keys(book), async (m) => {
      if (m === 'b' && tries++ === 0) throw timeout()
      return book[m]
    })
    expect(r).toEqual({ totalWei: 23n, unread: [] })
  })

  // The soak's two false CRITICALs: a market that could not be read went into
  // the sum as zero, and the monitor reported its whole balance as missing.
  it('names a market it cannot read instead of counting it as empty', async () => {
    const r = await sumBalances(Object.keys(book), async (m) => {
      if (m === 'b') throw timeout()
      return book[m]
    })
    expect(r.unread).toEqual(['b'])
    expect(r.totalWei).toBe(16n)
  })

  it('reports the whole book unread when the chain does not answer at all', async () => {
    const r = await sumBalances(Object.keys(book), async () => { throw new Error('HTTP request failed.') })
    expect(r.unread).toEqual(['a', 'b', 'c'])
  })
})

describe('nextUnmeasured', () => {
  it('starts the clock the first time the monitor goes blind', () => {
    expect(JSON.parse(nextUnmeasured(null, 1_000, 2, 6))).toMatchObject({ since: 1_000, unread: 2, total: 6 })
  })

  it('keeps the original start for as long as it stays blind', () => {
    const first = nextUnmeasured(null, 1_000, 2, 6)
    expect(JSON.parse(nextUnmeasured(first, 61_000, 6, 6)).since).toBe(1_000)
  })

  it('restarts the clock rather than trusting a corrupt record', () => {
    expect(JSON.parse(nextUnmeasured('{not json', 5_000, 1, 6)).since).toBe(5_000)
  })
})
