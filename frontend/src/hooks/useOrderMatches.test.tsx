import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { orderKey, useOrderMatches } from './useOrderMatches'

/**
 * useOrderMatches keeps its state per (market, orderId).
 *
 * React Router does not remount a page across a param change, so the old hook
 * - plain useState, no key - kept order 1's matches on screen after navigating
 * to order 2, and on a 404 (`if (!res.ok) return`) kept them there for good.
 */

const MARKET = '0x00000000000000000000000000000000000000aa' as const
const OTHER_MARKET = '0x00000000000000000000000000000000000000bb' as const

const match = (matchId: string, over: Record<string, unknown> = {}) => ({
  matchId, isLpMatch: false, amount: 0.01, settled: false, settleAt: 1_800_000_000, outcome: 'pending', ...over,
})

/** Answers by order id, so a test can say what each order's record is. */
type Reply = { status: number; body?: unknown }
let replies: Record<string, Reply>
let fetchCalls: string[]

function Probe({ market = MARKET, id }: { market?: `0x${string}`; id: bigint }) {
  const r = useOrderMatches(market, id)
  return (
    <>
      <div data-testid="ids">{r.matches.map((m) => m.matchId).join(',')}</div>
      <div data-testid="loading">{String(r.isLoading)}</div>
      <div data-testid="error">{String(r.isError)}</div>
      <div data-testid="notfound">{String(r.notFound)}</div>
      <div data-testid="payout">{String(r.payout)}</div>
    </>
  )
}

const text = (id: string) => screen.getByTestId(id).textContent

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  fetchCalls = []
  replies = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetchCalls.push(url)
      const orderId = url.split('/').pop() as string
      const reply = replies[orderId] ?? { status: 404 }
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body }
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  cleanup()
})

describe('useOrderMatches', () => {
  it('reports loading, then the matches and the stored payout', async () => {
    replies['1'] = { status: 200, body: { matches: [match('7'), match('8')], payout: 0.0196 } }

    render(<Probe id={1n} />)
    expect(text('loading')).toBe('true')
    expect(text('ids')).toBe('')

    await flush()

    expect(text('loading')).toBe('false')
    expect(text('ids')).toBe('7,8')
    expect(text('payout')).toBe('0.0196')
    expect(text('error')).toBe('false')
    expect(fetchCalls[0]).toMatch(new RegExp(`/api/markets/${MARKET}/orders/1$`))
  })

  it('never shows one order\'s matches under another order', async () => {
    replies['1'] = { status: 200, body: { matches: [match('7')], payout: null } }
    replies['2'] = { status: 200, body: { matches: [match('9')], payout: null } }

    const { rerender } = render(<Probe id={1n} />)
    await flush()
    expect(text('ids')).toBe('7')

    rerender(<Probe id={2n} />)
    // The very next render, before order 2's answer: nothing left over from order 1.
    expect(text('ids')).toBe('')
    expect(text('loading')).toBe('true')

    await flush()
    expect(text('ids')).toBe('9')
  })

  it('a different market is a different key, even for the same order id', async () => {
    replies['1'] = { status: 200, body: { matches: [match('7')], payout: null } }

    const { rerender } = render(<Probe id={1n} />)
    await flush()
    expect(text('ids')).toBe('7')

    replies['1'] = { status: 404 }
    rerender(<Probe market={OTHER_MARKET} id={1n} />)
    expect(text('ids')).toBe('')
    await flush()
    expect(text('ids')).toBe('')
    expect(text('notfound')).toBe('true')
  })

  it('clears the list on a 404 instead of keeping another order\'s matches', async () => {
    replies['1'] = { status: 200, body: { matches: [match('7')], payout: 0.5 } }

    const { rerender } = render(<Probe id={1n} />)
    await flush()
    expect(text('ids')).toBe('7')

    // Order 2 is not in the backend: 404. Order 1's list must not survive it.
    rerender(<Probe id={2n} />)
    await flush()

    expect(text('ids')).toBe('')
    expect(text('payout')).toBe('null')
    expect(text('notfound')).toBe('true')
    expect(text('loading')).toBe('false')
    expect(text('error')).toBe('false')
  })

  it('clears the list when the same order starts answering 404 on a later poll', async () => {
    replies['1'] = { status: 200, body: { matches: [match('7')], payout: null } }
    render(<Probe id={1n} />)
    await flush()
    expect(text('ids')).toBe('7')

    replies['1'] = { status: 404 }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000) // the poll
    })

    expect(text('ids')).toBe('')
    expect(text('notfound')).toBe('true')
  })

  it('keeps the same order\'s last list through a transient failure, and says it may be out of date', async () => {
    replies['1'] = { status: 200, body: { matches: [match('7')], payout: null } }
    render(<Probe id={1n} />)
    await flush()

    replies['1'] = { status: 500 }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(text('ids')).toBe('7')
    expect(text('error')).toBe('true')

    // ...and recovers on its own.
    replies['1'] = { status: 200, body: { matches: [match('7'), match('8')], payout: null } }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(text('ids')).toBe('7,8')
    expect(text('error')).toBe('false')
  })

  it('a failure before any answer is an error, not an endless loading state', async () => {
    replies['1'] = { status: 500 }
    render(<Probe id={1n} />)
    await flush()
    expect(text('error')).toBe('true')
    expect(text('loading')).toBe('false')
    expect(text('ids')).toBe('')
  })

  it('drops an answer that arrives for an order the page has already left', async () => {
    // Order 1's request stays open; order 2's answers first; then order 1's lands.
    const resolvers: Record<string, (r: unknown) => void> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const orderId = url.split('/').pop() as string
        return new Promise((resolve) => {
          resolvers[orderId] = resolve
        })
      }),
    )
    const ok = (matches: unknown[]) => ({ ok: true, status: 200, json: async () => ({ matches, payout: null }) })

    const { rerender } = render(<Probe id={1n} />)
    rerender(<Probe id={2n} />)
    await flush()

    resolvers['2'](ok([match('9')]))
    await flush()
    expect(text('ids')).toBe('9')

    resolvers['1'](ok([match('7')]))
    await flush()
    expect(text('ids')).toBe('9') // the late answer for order 1 is stale
  })

  it('tolerates a malformed body', async () => {
    replies['1'] = { status: 200, body: { matches: 'nope', payout: 'lots' } }
    render(<Probe id={1n} />)
    await flush()
    expect(text('ids')).toBe('')
    expect(text('payout')).toBe('null')
    expect(text('error')).toBe('false')
  })

  it('does not ask the API about order 0', async () => {
    render(<Probe id={0n} />)
    await flush()
    expect(fetchCalls).toHaveLength(0)
    expect(text('loading')).toBe('false')
  })

  it('polls again every 10 seconds', async () => {
    replies['1'] = { status: 200, body: { matches: [], payout: null } }
    render(<Probe id={1n} />)
    await flush()
    const first = fetchCalls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(fetchCalls.length).toBeGreaterThan(first)
  })
})

describe('orderKey', () => {
  it('is case-insensitive on the address', () => {
    expect(orderKey('0xAbC0000000000000000000000000000000000001', 5n)).toBe(
      orderKey('0xabc0000000000000000000000000000000000001', 5n),
    )
    expect(orderKey(MARKET, 1n)).not.toBe(orderKey(MARKET, 2n))
    expect(orderKey(MARKET, 1n)).not.toBe(orderKey(OTHER_MARKET, 1n))
  })
})
