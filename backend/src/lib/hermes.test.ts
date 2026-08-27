import { describe, it, expect, vi, afterEach } from 'vitest'
import { hermesHeaders, hermesFetch, HermesAuthError } from './hermes.js'

const KEY = 'pyth-api-key-value'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('hermesHeaders', () => {
  it('authenticates with the key as a bearer token', () => {
    expect(hermesHeaders(KEY)).toEqual({ Authorization: `Bearer ${KEY}` })
  })

  // The failure this module exists to prevent. Pyth closed the public Hermes
  // endpoint on 2026-08-26 16:00 UTC; every unauthenticated call now returns
  // 401, and the keeper's retry loop swallowed that into console.error and
  // kept reporting healthy. A missing key has to stop the caller outright.
  it('refuses to build an unauthenticated request when no key is configured', () => {
    expect(() => hermesHeaders(undefined)).toThrow(HermesAuthError)
    expect(() => hermesHeaders('')).toThrow(HermesAuthError)
  })

  it('names the environment variable to set, so the log says what to do', () => {
    expect(() => hermesHeaders(undefined)).toThrow(/PYTH_API_KEY/)
  })
})

describe('hermesFetch', () => {
  it('sends the bearer token upstream', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', spy)

    await hermesFetch('https://hermes.example/v2/updates/price/latest', KEY)

    expect(spy).toHaveBeenCalledTimes(1)
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://hermes.example/v2/updates/price/latest')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
  })

  it('does not reach the network at all when the key is missing', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', spy)

    await expect(hermesFetch('https://hermes.example/x', undefined))
      .rejects.toThrow(HermesAuthError)
    expect(spy).not.toHaveBeenCalled()
  })

  // A 401 is now a configuration problem, not a transient blip, and it read as
  // an ordinary fetch failure in every caller's catch block.
  it('reports an unauthorized response as an auth failure, not a generic status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })))

    await expect(hermesFetch('https://hermes.example/x', KEY))
      .rejects.toThrow(HermesAuthError)
  })

  it('passes other failures through with their status for the caller to retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 503 })))

    await expect(hermesFetch('https://hermes.example/x', KEY)).rejects.toThrow(/503/)
    await expect(hermesFetch('https://hermes.example/x', KEY)).rejects.not.toThrow(HermesAuthError)
  })

  // The watchdog runs on a timer and pings every feed in sequence. A Hermes
  // that accepts the connection and then never answers would stall the whole
  // loop, and with it the balance checks and the health snapshot everything
  // else reads.
  it('gives up on a hung request instead of blocking the caller forever', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    ))

    await expect(hermesFetch('https://hermes.example/x', KEY, 20)).rejects.toThrow()
  })

  it('returns the response untouched when Hermes answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })))

    const res = await hermesFetch('https://hermes.example/x', KEY)
    expect(await res.json()).toEqual({ ok: true })
  })
})
