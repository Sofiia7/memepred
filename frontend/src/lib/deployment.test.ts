import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  evaluateDeployment,
  fetchDeployment,
  parseApiDeployment,
  DEPLOYMENT_TIMEOUT_MS,
  DEPLOYMENT_MISMATCH_MESSAGE,
} from './deployment'

/**
 * Audit U11 (2026-09-28): nothing compared the chain and factory this build
 * was made for with the RPC it reads and the API it lists markets from. The
 * rule that matters most is the asymmetry: a definite disagreement refuses to
 * sign, but a source that could not answer (the endpoint is not deployed yet,
 * the network is down) is "unknown" and must never block anyone.
 */

const FACTORY = '0xC52b8b69d266F9656Be11511907192EaFD521BcB'
const OTHER_FACTORY = '0x06C567A901275A729BEe9B1cfd0A084aa9D078Cf'
const CHAIN = 46630

const base = { expectedChainId: CHAIN, expectedFactory: FACTORY }

describe('evaluateDeployment', () => {
  it('is verified when both sources agree', () => {
    const v = evaluateDeployment({ ...base, rpcChainId: CHAIN, api: { chainId: CHAIN, factory: FACTORY } })
    expect(v).toEqual({ status: 'verified', rpc: 'match', api: 'match', reasons: [] })
  })

  it('compares factory addresses without regard to case', () => {
    const v = evaluateDeployment({ ...base, rpcChainId: CHAIN, api: { factory: FACTORY.toLowerCase() } })
    expect(v.api).toBe('match')
    expect(v.status).toBe('verified')
  })

  describe('a definite disagreement is a mismatch', () => {
    it('when the RPC is on a different chain', () => {
      const v = evaluateDeployment({ ...base, rpcChainId: 84532, api: { chainId: CHAIN, factory: FACTORY } })
      expect(v.status).toBe('mismatch')
      expect(v.rpc).toBe('mismatch')
      expect(v.reasons.join(' ')).toContain('84532')
    })

    it('when the API serves a different chain', () => {
      const v = evaluateDeployment({ ...base, rpcChainId: CHAIN, api: { chainId: 8453, factory: FACTORY } })
      expect(v.status).toBe('mismatch')
      expect(v.api).toBe('mismatch')
    })

    it('when the API indexes a different factory (the same chain, a redeployed stack)', () => {
      const v = evaluateDeployment({ ...base, rpcChainId: CHAIN, api: { chainId: CHAIN, factory: OTHER_FACTORY } })
      expect(v.status).toBe('mismatch')
      expect(v.api).toBe('mismatch')
      expect(v.reasons.join(' ')).toContain('factory')
    })

    it('even when the other source could not be asked', () => {
      expect(evaluateDeployment({ ...base, rpcChainId: 1, api: null }).status).toBe('mismatch')
      expect(evaluateDeployment({ ...base, rpcChainId: null, api: { factory: OTHER_FACTORY } }).status).toBe('mismatch')
    })

    it('when only the factory is reported and it differs', () => {
      expect(evaluateDeployment({ ...base, rpcChainId: CHAIN, api: { factory: OTHER_FACTORY } }).status).toBe('mismatch')
    })
  })

  describe('a source that could not answer is unknown, never a mismatch', () => {
    it('API unreachable or 404', () => {
      const v = evaluateDeployment({ ...base, rpcChainId: CHAIN, api: null })
      expect(v).toEqual({ status: 'unverified', rpc: 'match', api: 'unknown', reasons: [] })
      expect(evaluateDeployment({ ...base, rpcChainId: CHAIN }).status).toBe('unverified')
    })

    it('RPC unreadable', () => {
      const v = evaluateDeployment({ ...base, rpcChainId: null, api: { chainId: CHAIN, factory: FACTORY } })
      expect(v).toEqual({ status: 'unverified', rpc: 'unknown', api: 'match', reasons: [] })
    })

    it('both unreachable', () => {
      const v = evaluateDeployment({ ...base, rpcChainId: null, api: null })
      expect(v.status).toBe('unverified')
      expect(v.reasons).toEqual([])
    })

    it('an API answer with nothing comparable in it', () => {
      const v = evaluateDeployment({ ...base, rpcChainId: CHAIN, api: {} })
      expect(v.api).toBe('unknown')
      expect(v.status).toBe('unverified')
    })
  })

  it('has one fixed sentence for the banner and the Composer', () => {
    expect(DEPLOYMENT_MISMATCH_MESSAGE).toBe('This site is configured for a different deployment than its API')
  })
})

describe('parseApiDeployment', () => {
  it('reads the fields the check compares and ignores the rest', () => {
    const parsed = parseApiDeployment({
      chainId: CHAIN,
      profile: 'rhc-testnet',
      factory: FACTORY,
      resolver: OTHER_FACTORY,
      liquidityPool: OTHER_FACTORY,
      stakeToken: OTHER_FACTORY,
      indexerStartBlock: 123,
      commit: 'abc1234',
    })
    expect(parsed).toEqual({ chainId: CHAIN, factory: FACTORY })
  })

  it('accepts a chain id sent as a numeric string', () => {
    expect(parseApiDeployment({ chainId: '46630' })).toEqual({ chainId: 46630 })
  })

  it('drops a malformed field instead of treating it as a disagreement', () => {
    expect(parseApiDeployment({ chainId: 'sepolia', factory: '0x123' })).toBeNull()
    expect(parseApiDeployment({ chainId: -1, factory: FACTORY })).toEqual({ factory: FACTORY })
    expect(parseApiDeployment({ chainId: CHAIN, factory: 'not an address' })).toEqual({ chainId: CHAIN })
  })

  it('returns null for anything that is not an object with something to compare', () => {
    for (const bad of [null, undefined, 'x', 42, [], {}, { error: 'not found' }]) {
      expect(parseApiDeployment(bad)).toBeNull()
    }
  })
})

describe('fetchDeployment', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const json = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

  it('asks GET {api}/api/deployment', async () => {
    const f = vi.fn(async () => json(200, { chainId: CHAIN, factory: FACTORY }))
    expect(await fetchDeployment('https://api.test', f as unknown as typeof fetch)).toEqual({ chainId: CHAIN, factory: FACTORY })
    expect((f.mock.calls[0] as unknown[])[0]).toBe('https://api.test/api/deployment')
  })

  it('is null for a 404 (the endpoint has not shipped)', async () => {
    const f = vi.fn(async () => json(404, { error: 'Not Found' }))
    expect(await fetchDeployment('https://api.test', f as unknown as typeof fetch)).toBeNull()
  })

  it('is null for a 5xx, a network error, and a body that is not JSON', async () => {
    expect(await fetchDeployment('x', (async () => json(503, {})) as unknown as typeof fetch)).toBeNull()
    expect(await fetchDeployment('x', (async () => { throw new TypeError('network down') }) as unknown as typeof fetch)).toBeNull()
    const notJson = { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } } as unknown as Response
    expect(await fetchDeployment('x', (async () => notJson) as unknown as typeof fetch)).toBeNull()
  })

  it('gives up after the deadline instead of holding the check open', async () => {
    vi.useFakeTimers()
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch

    let result: unknown = 'pending'
    void fetchDeployment('x', hang).then((r) => { result = r })
    await vi.advanceTimersByTimeAsync(DEPLOYMENT_TIMEOUT_MS - 1)
    expect(result).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBeNull()
  })
})
