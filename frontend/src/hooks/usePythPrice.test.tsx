import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { usePythPrice, PRICE_STALE_AFTER_MS } from './usePythPrice'

/**
 * Audit U02 (2026-09-28): the price hook carried a price over to a different
 * feed, and its first failed read left `stale` false with a price of zero - so
 * the CTA stayed enabled and the bet went out with expectedPrice = 0, which the
 * contract rejects only after the user has paid for an approval.
 *
 * The states are separate words now (loading / unavailable / stale / live) and
 * a reading belongs to the feed it was read from.
 */

const flags = vi.hoisted(() => ({ pool: true }))

const readContract = vi.fn()
const client = { readContract }

vi.mock('wagmi', () => ({ usePublicClient: () => client }))
vi.mock('../lib/contracts', () => ({
  CONTRACTS: { ORACLE_RESOLVER: '0x00000000000000000000000000000000000000ee' },
  POOL_ORACLE_RESOLVER_ABI: [],
  get IS_POOL_BACKED() {
    return flags.pool
  },
}))
const fetchDisplayPrice = vi.fn()
vi.mock('../lib/oracle', () => ({ fetchDisplayPrice: (...a: unknown[]) => fetchDisplayPrice(...a) }))

const FEED_A = '0x000000000000000000000000000000000000000000000000000000000000000a'
const FEED_B = '0x000000000000000000000000000000000000000000000000000000000000000b'
const WAD = 10n ** 18n

/** Per-feed answer for the pool path: a bigint is a price, an Error is a failed read. */
let answers: Record<string, bigint | Error> = {}

function useFeed(feedId?: string | null) {
  return usePythPrice(feedId)
}

/** Lets the promises a tick started settle, without moving the clock much. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  flags.pool = true
  answers = { [FEED_A]: 2n * WAD, [FEED_B]: 5n * WAD }
  readContract.mockReset()
  readContract.mockImplementation(async ({ args }: { args: [string] }) => {
    const a = answers[args[0]]
    if (a === undefined) throw new Error('no such feed')
    if (a instanceof Error) throw a
    return a
  })
  fetchDisplayPrice.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('usePythPrice, the states are separate', () => {
  it('is loading until the first read answers, then live', async () => {
    const { result } = renderHook(() => useFeed(FEED_A))
    expect(result.current.status).toBe('loading')
    expect(result.current.loading).toBe(true)
    expect(result.current.raw).toBe(0n)

    await flush()

    expect(result.current.status).toBe('live')
    expect(result.current.loading).toBe(false)
    expect(result.current.stale).toBe(false)
    expect(result.current.unavailable).toBe(false)
    expect(result.current.raw).toBe(2n * WAD)
    expect(result.current.display).toBe(2)
  })

  it('is unavailable, not live and not stale, when the very first read fails', async () => {
    // The old hook left stale = false here (it only counted a failure once
    // there had been a success) and raw = 0n, with the CTA still enabled.
    answers[FEED_A] = new Error('rpc down')
    const { result } = renderHook(() => useFeed(FEED_A))

    await flush()

    expect(result.current.status).toBe('unavailable')
    expect(result.current.unavailable).toBe(true)
    expect(result.current.loading).toBe(false)
    expect(result.current.stale).toBe(false)
    expect(result.current.raw).toBe(0n)
  })

  it('treats a zero price as a failure, not as a price', async () => {
    answers[FEED_A] = 0n
    const { result } = renderHook(() => useFeed(FEED_A))

    await flush()

    expect(result.current.status).toBe('unavailable')
    expect(result.current.raw).toBe(0n)
  })

  it('is idle, and reads nothing, when there is no feed to price', async () => {
    for (const none of [undefined, null, '']) {
      const { result, unmount } = renderHook(() => useFeed(none))
      await flush()
      expect(result.current.status).toBe('idle')
      expect(result.current.loading).toBe(false)
      expect(result.current.raw).toBe(0n)
      unmount()
    }
    expect(readContract).not.toHaveBeenCalled()
  })
})

describe('usePythPrice, staleness', () => {
  it('turns stale once reads keep failing for longer than the threshold, keeping the last price', async () => {
    const { result } = renderHook(() => useFeed(FEED_A))
    await flush()
    expect(result.current.status).toBe('live')

    answers[FEED_A] = new Error('rpc down')
    await advance(PRICE_STALE_AFTER_MS + 10_000)

    expect(result.current.status).toBe('stale')
    expect(result.current.stale).toBe(true)
    // The number stays on screen, which is right: a blank is worse than an
    // old price. It is just no longer labelled live.
    expect(result.current.raw).toBe(2n * WAD)
  })

  it('does not go stale while reads keep succeeding', async () => {
    const { result } = renderHook(() => useFeed(FEED_A))
    await advance(PRICE_STALE_AFTER_MS * 3)
    expect(result.current.status).toBe('live')
  })

  it('goes back to live when reads recover', async () => {
    const { result } = renderHook(() => useFeed(FEED_A))
    await flush()
    answers[FEED_A] = new Error('rpc down')
    await advance(PRICE_STALE_AFTER_MS + 10_000)
    expect(result.current.status).toBe('stale')

    answers[FEED_A] = 3n * WAD
    await advance(10_000)

    expect(result.current.status).toBe('live')
    expect(result.current.raw).toBe(3n * WAD)
  })
})

describe('usePythPrice, state does not follow a feed change', () => {
  it('drops the previous feed\'s price the moment the feed changes', async () => {
    const { result, rerender } = renderHook(({ feed }) => useFeed(feed), { initialProps: { feed: FEED_A } })
    await flush()
    expect(result.current.raw).toBe(2n * WAD)

    // B's read is held open, so what is observed is the state in between.
    let release!: () => void
    readContract.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve(5n * WAD) }),
    )
    rerender({ feed: FEED_B })

    // Same render as the change: not a single frame of A's price under B.
    expect(result.current.status).toBe('loading')
    expect(result.current.raw).toBe(0n)
    expect(result.current.display).toBe(0)

    await act(async () => {
      release()
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(result.current.status).toBe('live')
    expect(result.current.raw).toBe(5n * WAD)
  })

  it('does not present the previous feed\'s price as the new feed\'s when the new one fails', async () => {
    const { result, rerender } = renderHook(({ feed }) => useFeed(feed), { initialProps: { feed: FEED_A } })
    await flush()
    expect(result.current.status).toBe('live')

    answers[FEED_B] = new Error('pool has no liquidity')
    rerender({ feed: FEED_B })
    await flush()

    expect(result.current.status).toBe('unavailable')
    expect(result.current.raw).toBe(0n)
  })

  it('ignores a slow answer for a feed that is no longer the one asked about', async () => {
    let releaseA!: () => void
    readContract.mockImplementationOnce(
      () => new Promise((resolve) => { releaseA = () => resolve(2n * WAD) }),
    )
    const { result, rerender } = renderHook(({ feed }) => useFeed(feed), { initialProps: { feed: FEED_A } })
    rerender({ feed: FEED_B })
    await flush()
    expect(result.current.raw).toBe(5n * WAD)

    await act(async () => {
      releaseA() // A answers late, after B is already showing
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(result.current.raw).toBe(5n * WAD)
  })

  it('becomes idle again, with no price, when the feed goes away', async () => {
    const { result, rerender } = renderHook(({ feed }) => useFeed(feed), {
      initialProps: { feed: FEED_A as string | undefined },
    })
    await flush()
    expect(result.current.status).toBe('live')

    rerender({ feed: undefined })

    expect(result.current.status).toBe('idle')
    expect(result.current.raw).toBe(0n)
  })
})

describe('usePythPrice, the Base path', () => {
  it('reads the display price through the API and scales it to 1e18', async () => {
    flags.pool = false
    fetchDisplayPrice.mockResolvedValue(0.5)
    const { result } = renderHook(() => useFeed(FEED_A))
    await flush()

    expect(readContract).not.toHaveBeenCalled()
    expect(result.current.status).toBe('live')
    expect(result.current.raw).toBe(WAD / 2n)
  })

  it('is unavailable when the API price call fails', async () => {
    flags.pool = false
    fetchDisplayPrice.mockRejectedValue(new Error('price feed 503'))
    const { result } = renderHook(() => useFeed(FEED_A))
    await flush()

    expect(result.current.status).toBe('unavailable')
  })
})
