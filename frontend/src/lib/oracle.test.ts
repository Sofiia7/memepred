import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { feedSymbolFromBytes32, fetchBetPayload, fetchDisplayPrice, withPayload } from './oracle.js'

const PEPE_ID = '0x5045504500000000000000000000000000000000000000000000000000000000'

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', 'https://api.flipthememe.com')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('feedSymbolFromBytes32', () => {
  /**
   * A market stores its feed as a padded symbol, and the gateway is keyed by
   * the bare symbol. Leaving the padding on does not fail loudly - the request
   * just comes back with no packages for a feed nobody has heard of.
   */
  it('strips the padding a bytes32 feed id carries', () => {
    expect(feedSymbolFromBytes32(PEPE_ID)).toBe('PEPE')
  })

  it('handles an id without the 0x prefix', () => {
    expect(feedSymbolFromBytes32(PEPE_ID.slice(2))).toBe('PEPE')
  })

  it('keeps distinct feeds distinct', () => {
    const doge = '0x444f474500000000000000000000000000000000000000000000000000000000'
    expect(feedSymbolFromBytes32(doge)).toBe('DOGE')
  })
})

describe('withPayload', () => {
  it('appends the payload after the encoded call', () => {
    expect(withPayload('0xdeadbeef', '0xcafe')).toBe('0xdeadbeefcafe')
  })

  it('leaves the selector where the node expects it', () => {
    expect(withPayload('0xdeadbeef', '0xcafe').slice(0, 10)).toBe('0xdeadbeef')
  })
})

describe('fetchBetPayload', () => {
  /**
   * The browser must never hold an oracle credential - Vite inlines every
   * VITE_* value into the public bundle - and with RedStone there is none to
   * hold. This pins that the request stays a plain unauthenticated GET to our
   * own API.
   */
  it('asks our own API, with no credential attached', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ payload: '0xabcd' })))
    vi.stubGlobal('fetch', spy)

    await fetchBetPayload(PEPE_ID)

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit | undefined]
    expect(url).toBe('https://api.flipthememe.com/api/oracle/payload?feed=PEPE')
    expect(url).not.toContain('redstone')
    expect(JSON.stringify(init ?? {})).not.toMatch(/authorization|api[-_]?key/i)
  })

  it('returns the signed payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ payload: '0xabcd' }))))

    expect(await fetchBetPayload(PEPE_ID)).toBe('0xabcd')
  })

  /**
   * There is no fallback and must not be one: pricing a bet off anything but a
   * fresh signed update is the stale-strike hole the pull model exists to
   * close. Failing here and asking the user to retry is the correct outcome.
   */
  it('fails rather than letting a bet through unpriced', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })))

    await expect(fetchBetPayload(PEPE_ID)).rejects.toThrow(/502/)
  })

  it('rejects an empty payload as firmly as a failed request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ payload: '0x' }))))

    await expect(fetchBetPayload(PEPE_ID)).rejects.toThrow(/signed price/i)
  })
})

describe('fetchDisplayPrice', () => {
  it('returns the price for a feed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ price: 0.00000392 }))))

    expect(await fetchDisplayPrice(PEPE_ID)).toBe(0.00000392)
  })

  it('never points the browser at the oracle directly', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ price: 1 })))
    vi.stubGlobal('fetch', spy)

    await fetchDisplayPrice(PEPE_ID)

    const [url] = spy.mock.calls[0] as unknown as [string]
    expect(url).toContain('/api/oracle/price')
  })
})
