import { describe, it, expect } from 'vitest'
import { oneLine } from '../lib/errorText'
import {
  PoisonTracker,
  redisPoisonSink,
  POISON_KEY,
  POISON_TTL_SEC,
  type PoisonRecord,
  type PoisonSubject,
} from './poisonTracker'

const LOG_A: PoisonSubject = { txHash: '0xaaa', logIndex: 4, market: '0xmarket', event: 'OrderMatched' }
const LOG_B: PoisonSubject = { txHash: '0xbbb', logIndex: 0, market: '0xmarket', event: 'Claimed' }

function harness(opts: { publishFails?: boolean; clearFails?: boolean } = {}) {
  const published: PoisonRecord[] = []
  const lines: string[] = []
  let cleared = 0
  let t = 1_000
  const tracker = new PoisonTracker(
    {
      publish: async (r) => {
        if (opts.publishFails) throw new Error('redis down')
        published.push(r)
      },
      clear: async () => {
        if (opts.clearFails) throw new Error('redis down')
        cleared++
      },
    },
    { now: () => t, log: (l) => lines.push(l) },
  )
  return { tracker, published, lines, cleared: () => cleared, tick: (ms: number) => { t += ms } }
}

describe('PoisonTracker', () => {
  it('stays quiet for a blip and only publishes from the third consecutive failure', async () => {
    const h = harness()
    await h.tracker.failed(LOG_A, new Error('boom'))
    await h.tracker.failed(LOG_A, new Error('boom'))
    expect(h.published).toHaveLength(0)
    expect(h.lines).toHaveLength(0)

    h.tick(45_000)
    expect(await h.tracker.failed(LOG_A, new Error('boom'))).toBe(3)
    expect(h.published).toHaveLength(1)
    expect(h.lines).toHaveLength(1)
    expect(h.lines[0]).toContain('CRITICAL')
    expect(h.lines[0]).toContain('0xaaa#4')
    expect(h.lines[0]).toContain('0xmarket')
  })

  it('keeps the first-failure time and refreshes the record on every later failure', async () => {
    const h = harness()
    for (let i = 0; i < 3; i++) {
      await h.tracker.failed(LOG_A, new Error('boom'))
      h.tick(45_000)
    }
    await h.tracker.failed(LOG_A, new Error('still boom'))

    const last = h.published[h.published.length - 1]
    expect(last.failures).toBe(4)
    expect(last.firstFailedAt).toBe(1_000)
    expect(last.lastFailedAt).toBe(1_000 + 3 * 45_000)
    expect(last.error).toBe('still boom')
    // One publish per failure at or past the threshold: this is what refreshes the TTL.
    expect(h.published).toHaveLength(2)
  })

  it('counts consecutive failures of the SAME log only', async () => {
    const h = harness()
    await h.tracker.failed(LOG_A, new Error('a'))
    await h.tracker.failed(LOG_A, new Error('a'))
    await h.tracker.failed(LOG_B, new Error('b')) // the stream moved on to a different log
    expect(h.tracker.failures).toBe(1)
    await h.tracker.failed(LOG_A, new Error('a')) // and back: the count starts over
    expect(h.tracker.failures).toBe(1)
    expect(h.published).toHaveLength(0)
  })

  it('tracks a chunk-level failure that belongs to no single log', async () => {
    const h = harness({})
    const chunk: PoisonSubject = { txHash: null, logIndex: null, market: null, event: 'projection-sync' }
    for (let i = 0; i < 3; i++) await h.tracker.failed(chunk, new Error('numeric overflow'))
    expect(h.published).toHaveLength(1)
    expect(h.lines[0]).toContain('projection-sync')
    expect(h.lines[0]).toContain('chunk#-')
  })

  it('clears the flag when a chunk goes through, and only once', async () => {
    const h = harness()
    for (let i = 0; i < 3; i++) await h.tracker.failed(LOG_A, new Error('boom'))
    await h.tracker.succeeded()
    expect(h.cleared()).toBe(1)
    expect(h.tracker.failures).toBe(0)

    await h.tracker.succeeded()
    await h.tracker.succeeded()
    expect(h.cleared()).toBe(1) // nothing was failing, so no Redis call per chunk
  })

  it('clears once on the first success after a start, to drop a flag its predecessor left behind', async () => {
    const h = harness()
    await h.tracker.succeeded()
    expect(h.cleared()).toBe(1)
  })

  it('never lets a broken sink change what the indexer does', async () => {
    const h = harness({ publishFails: true, clearFails: true })
    for (let i = 0; i < 3; i++) {
      await expect(h.tracker.failed(LOG_A, new Error('boom'))).resolves.toBeGreaterThan(0)
    }
    await expect(h.tracker.succeeded()).resolves.toBeUndefined()
    expect(h.lines.some((l) => l.includes('could not publish'))).toBe(true)
    expect(h.lines.some((l) => l.includes('could not clear'))).toBe(true)

    // A failed clear is retried on the next success rather than forgotten.
    const h2 = harness({ clearFails: true })
    await h2.tracker.succeeded()
    expect(h2.cleared()).toBe(0)
  })
})

describe('oneLine', () => {
  it('prefers shortMessage, keeps the first line only and truncates', () => {
    expect(oneLine({ shortMessage: 'The contract reverted', message: 'long\nmultiline' })).toBe('The contract reverted')
    expect(oneLine(new Error('line one\nline two'))).toBe('line one')
    expect(oneLine('plain string')).toBe('plain string')
    expect(oneLine(new Error('x'.repeat(500))).length).toBe(200)
  })

  it('never lets a URL through: an RPC endpoint can carry its API key in the path', () => {
    expect(oneLine(new Error('HTTP request failed. URL: https://rpc.example.com/v2/SECRETKEY123 Status: 429')))
      .toBe('HTTP request failed. URL: <url> Status: 429')
    expect(oneLine({ shortMessage: 'connect ECONNREFUSED postgres://user:pw@10.0.0.5:5432/db' }))
      .toBe('connect ECONNREFUSED <url>')
  })
})

describe('redisPoisonSink', () => {
  it('writes one key with a short TTL and deletes it on clear', async () => {
    const calls: unknown[][] = []
    const sink = redisPoisonSink({
      setEx: async (...a) => { calls.push(['setEx', ...a]) },
      del: async (...a) => { calls.push(['del', ...a]) },
    })
    const rec: PoisonRecord = { ...LOG_A, failures: 3, firstFailedAt: 1, lastFailedAt: 2, error: 'boom' }
    await sink.publish(rec)
    await sink.clear()

    expect(calls[0].slice(0, 3)).toEqual(['setEx', POISON_KEY, POISON_TTL_SEC])
    expect(JSON.parse(calls[0][3] as string)).toEqual(rec)
    expect(calls[1]).toEqual(['del', POISON_KEY])
    expect(POISON_KEY).toBe('keeper:indexer:poison')
    expect(POISON_TTL_SEC).toBeGreaterThanOrEqual(120)
    expect(POISON_TTL_SEC).toBeLessThanOrEqual(600)
  })
})
