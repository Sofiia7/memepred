import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The region check has three answers, not two.
 *
 * It used to return { blocked: boolean }, and any failed request was reported
 * as blocked=true - so an API that was merely unreachable put the REGION
 * BLOCKED screen (which names countries and talks about licences) in front of
 * a visitor from a permitted country. "We could not ask" and "your country is
 * excluded" are different facts. Both still keep the app closed, but they say
 * different things and only one of them can be retried.
 */

type Geo = typeof import('./geocheck')

const API = 'https://api.test'

/** A minimal Response stand-in: the check only reads status, ok and json(). */
function res(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input')
      return body
    },
  }
}

/** Routes by URL suffix; anything not listed rejects like a dead network. */
function routeFetch(routes: Record<string, () => unknown | Promise<unknown>>) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    for (const [suffix, make] of Object.entries(routes)) {
      if (String(url).endsWith(suffix)) return (await make()) as any
    }
    throw new TypeError('network down')
  })
}

async function load(): Promise<Geo> {
  vi.resetModules() // the blocked list is cached at module level
  return import('./geocheck')
}

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', API)
  vi.stubEnv('VITE_DISABLE_GEOBLOCK', '0')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('checkGeo, the answers', () => {
  it('allows a country that is not on the list', async () => {
    vi.stubGlobal('fetch', routeFetch({
      '/api/geo': () => res(200, { country: 'ES' }),
      '/api/geo/config': () => res(200, { blocked: ['US', 'DE'] }),
    }))
    const { checkGeo } = await load()
    expect(await checkGeo()).toEqual({ status: 'allowed', country: 'ES' })
  })

  it("blocks a country that is on the Worker's list, and says which", async () => {
    vi.stubGlobal('fetch', routeFetch({
      '/api/geo': () => res(200, { country: 'DE' }),
      '/api/geo/config': () => res(200, { blocked: ['US', 'DE'] }),
    }))
    const { checkGeo } = await load()
    expect(await checkGeo()).toEqual({ status: 'blocked', country: 'DE' })
  })

  it("treats the Worker's list as authoritative over the built-in one", async () => {
    vi.stubGlobal('fetch', routeFetch({
      '/api/geo': () => res(200, { country: 'ES' }),
      '/api/geo/config': () => res(200, { blocked: ['ES'] }),
    }))
    const { checkGeo } = await load()
    expect((await checkGeo()).status).toBe('blocked')
  })

  it('reads a 451 from the edge as blocked, taking the country from its body', async () => {
    vi.stubGlobal('fetch', routeFetch({
      '/api/geo': () => res(451, { error: 'region_blocked', country: 'SG' }),
    }))
    const { checkGeo } = await load()
    expect(await checkGeo()).toEqual({ status: 'blocked', country: 'SG' })
  })

  it('still reads a 451 with no usable body as blocked', async () => {
    vi.stubGlobal('fetch', routeFetch({ '/api/geo': () => res(451, undefined) }))
    const { checkGeo } = await load()
    expect(await checkGeo()).toEqual({ status: 'blocked', country: 'XX' })
  })

  it('normalises the case of the country code before comparing', async () => {
    vi.stubGlobal('fetch', routeFetch({
      '/api/geo': () => res(200, { country: 'us' }),
      '/api/geo/config': () => res(200, { blocked: ['US'] }),
    }))
    const { checkGeo } = await load()
    expect((await checkGeo()).status).toBe('blocked')
  })
})

describe('checkGeo, "could not verify" is not "blocked"', () => {
  it('is unverified when the network is down', async () => {
    vi.stubGlobal('fetch', routeFetch({}))
    const { checkGeo } = await load()
    expect(await checkGeo()).toEqual({ status: 'unverified', country: 'XX' })
  })

  it('is unverified on a 5xx from the API', async () => {
    vi.stubGlobal('fetch', routeFetch({ '/api/geo': () => res(503, { error: 'down' }) }))
    const { checkGeo } = await load()
    expect((await checkGeo()).status).toBe('unverified')
  })

  it('is unverified on a 404 (the DNS name exists but the route does not)', async () => {
    vi.stubGlobal('fetch', routeFetch({ '/api/geo': () => res(404, { error: 'nope' }) }))
    const { checkGeo } = await load()
    expect((await checkGeo()).status).toBe('unverified')
  })

  it('is unverified when a 200 answer cannot be read', async () => {
    vi.stubGlobal('fetch', routeFetch({ '/api/geo': () => res(200, undefined) }))
    const { checkGeo } = await load()
    expect((await checkGeo()).status).toBe('unverified')
  })

  it('never reports blocked or allowed without a definite reason to', async () => {
    vi.stubGlobal('fetch', routeFetch({ '/api/geo': () => res(500, { error: 'boom' }) }))
    const { checkGeo } = await load()
    const { status } = await checkGeo()
    expect(status).not.toBe('blocked')
    expect(status).not.toBe('allowed')
  })
})

describe('checkGeo, the deadline', () => {
  /** A fetch that never answers, but honours the abort signal like the real one. */
  function hangingFetch() {
    return vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
  }

  it('gives up after 8 seconds and reports unverified instead of hanging', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', hangingFetch())
    const { checkGeo, GEO_TIMEOUT_MS } = await load()
    expect(GEO_TIMEOUT_MS).toBe(8_000)

    let settled: unknown
    void checkGeo().then((r) => {
      settled = r
    })

    await vi.advanceTimersByTimeAsync(7_999)
    expect(settled).toBeUndefined() // still waiting, not blocked, not allowed

    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toEqual({ status: 'unverified', country: 'XX' })
  })

  it('also covers a server that answers and then stalls on the body', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => ({
        status: 200,
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          }),
      })),
    )
    const { checkGeo } = await load()

    let settled: unknown
    void checkGeo().then((r) => {
      settled = r
    })
    await vi.advanceTimersByTimeAsync(8_000)
    expect(settled).toEqual({ status: 'unverified', country: 'XX' })
  })

  it('does not let a hung config request hold up a country that already answered', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (String(url).endsWith('/api/geo')) return Promise.resolve(res(200, { country: 'ES' }))
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }),
    )
    const { checkGeo } = await load()

    let settled: unknown
    void checkGeo().then((r) => {
      settled = r
    })
    await vi.advanceTimersByTimeAsync(8_000)
    // Falls back to the built-in list, which is as strict as the Worker's.
    expect(settled).toEqual({ status: 'allowed', country: 'ES' })
  })
})

describe('checkGeo, the built-in fallback list', () => {
  /**
   * The Worker's list is the authority, but when /api/geo/config cannot be
   * reached the check falls back to a copy of it. Which countries are on it is
   * a legal decision that belongs to the owner, so these pin it: a change to
   * the list has to be a change to this test as well.
   */
  const configDown = {
    '/api/geo/config': () => {
      throw new TypeError('config down')
    },
  }

  it.each([
    'CU', 'IR', 'KP', 'SY',
    'US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM',
    'GB', 'FR', 'DE', 'NL', 'CA', 'AU', 'JP', 'SG',
    'T1',
  ])('blocks %s', async (country) => {
    vi.stubGlobal('fetch', routeFetch({ '/api/geo': () => res(200, { country }), ...configDown }))
    const { checkGeo } = await load()
    expect(await checkGeo()).toEqual({ status: 'blocked', country })
  })

  it('does not block a country that is not on it', async () => {
    vi.stubGlobal('fetch', routeFetch({ '/api/geo': () => res(200, { country: 'ES' }), ...configDown }))
    const { checkGeo } = await load()
    expect((await checkGeo()).status).toBe('allowed')
  })

  it('does not trust an empty list from the Worker as "block nobody"', async () => {
    vi.stubGlobal('fetch', routeFetch({
      '/api/geo': () => res(200, { country: 'US' }),
      '/api/geo/config': () => res(200, { blocked: [] }),
    }))
    const { checkGeo } = await load()
    expect((await checkGeo()).status).toBe('blocked')
  })
})

describe('checkGeo, the preview switch', () => {
  it('VITE_DISABLE_GEOBLOCK=1 allows without asking anyone', async () => {
    vi.stubEnv('VITE_DISABLE_GEOBLOCK', '1')
    const fetchMock = routeFetch({})
    vi.stubGlobal('fetch', fetchMock)
    const { checkGeo } = await load()
    expect(await checkGeo()).toEqual({ status: 'allowed', country: 'XX' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('any other value leaves the check on', async () => {
    vi.stubEnv('VITE_DISABLE_GEOBLOCK', '0')
    vi.stubGlobal('fetch', routeFetch({}))
    const { checkGeo } = await load()
    expect((await checkGeo()).status).toBe('unverified')
  })
})

describe('checkGeo, a deployment that has opened a country', () => {
  const configDown = {
    '/api/geo/config': () => {
      throw new TypeError('config down')
    },
  }

  it('the fallback lets an opened country in when the Worker list cannot be read', async () => {
    vi.stubEnv('VITE_GEO_OPEN_COUNTRIES', 'SG')
    vi.stubGlobal('fetch', routeFetch({ '/api/geo': () => res(200, { country: 'SG' }), ...configDown }))
    const { checkGeo } = await load()
    expect(await checkGeo()).toEqual({ status: 'allowed', country: 'SG' })
  })

  it.each(['US', 'GB', 'DE', 'IR', 'T1'])('but still blocks %s', async (country) => {
    vi.stubEnv('VITE_GEO_OPEN_COUNTRIES', 'SG')
    vi.stubGlobal('fetch', routeFetch({ '/api/geo': () => res(200, { country }), ...configDown }))
    const { checkGeo } = await load()
    expect(await checkGeo()).toEqual({ status: 'blocked', country })
  })

  it('cannot be used to open an OFAC country, the US or Tor', async () => {
    vi.stubEnv('VITE_GEO_OPEN_COUNTRIES', 'IR,US,T1,SG')
    for (const country of ['IR', 'US', 'T1']) {
      vi.stubGlobal('fetch', routeFetch({ '/api/geo': () => res(200, { country }), ...configDown }))
      const { checkGeo } = await load()
      expect(await checkGeo()).toEqual({ status: 'blocked', country })
    }
  })
})

describe('checkGeo, a deployment that has switched the whole restricted list off', () => {
  // VITE_GEO_OPEN_ALL_RESTRICTED=1, the frontend half of the Worker's
  // GEO_OPEN_ALL_RESTRICTED (a testnet demo). The Worker's list stays the
  // authority; only the built-in fallback changes, and only for the
  // restricted jurisdictions, never for the OFAC countries.
  const configDown = {
    '/api/geo/config': () => {
      throw new TypeError('config down')
    },
  }

  it.each(['US', 'PR', 'GB', 'DE', 'SG', 'T1'])('the fallback lets %s in when the Worker list cannot be read', async (country) => {
    vi.stubEnv('VITE_GEO_OPEN_ALL_RESTRICTED', '1')
    vi.stubGlobal('fetch', routeFetch({ '/api/geo': () => res(200, { country }), ...configDown }))
    const { checkGeo } = await load()
    expect(await checkGeo()).toEqual({ status: 'allowed', country })
  })

  it.each(['CU', 'IR', 'KP', 'SY'])('but the fallback still blocks %s', async (country) => {
    vi.stubEnv('VITE_GEO_OPEN_ALL_RESTRICTED', '1')
    vi.stubGlobal('fetch', routeFetch({ '/api/geo': () => res(200, { country }), ...configDown }))
    const { checkGeo } = await load()
    expect(await checkGeo()).toEqual({ status: 'blocked', country })
  })

  it("still follows the Worker's own list when it can be read", async () => {
    vi.stubEnv('VITE_GEO_OPEN_ALL_RESTRICTED', '1')
    vi.stubGlobal('fetch', routeFetch({
      '/api/geo': () => res(200, { country: 'US' }),
      '/api/geo/config': () => res(200, { blocked: ['US'] }),
    }))
    const { checkGeo } = await load()
    expect(await checkGeo()).toEqual({ status: 'blocked', country: 'US' })
  })

  it('needs exactly "1"', async () => {
    vi.stubEnv('VITE_GEO_OPEN_ALL_RESTRICTED', 'true')
    vi.stubGlobal('fetch', routeFetch({ '/api/geo': () => res(200, { country: 'US' }), ...configDown }))
    const { checkGeo } = await load()
    expect(await checkGeo()).toEqual({ status: 'blocked', country: 'US' })
  })
})
