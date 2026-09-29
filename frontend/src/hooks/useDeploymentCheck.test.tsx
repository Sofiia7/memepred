import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

/**
 * The hook is a thin wrapper: ask the RPC and the API, hand both answers to
 * evaluateDeployment (whose rules are tested in lib/deployment.test.ts). What
 * is pinned here is the wiring - which chain and factory it compares against,
 * and that a source that fails is "unknown" and not "mismatch".
 */

const FACTORY = '0xC52b8b69d266F9656Be11511907192EaFD521BcB'
const CHAIN = 46630

const getChainId = vi.fn()
vi.mock('wagmi', () => ({ usePublicClient: () => ({ getChainId }) }))
vi.mock('../lib/contracts', () => ({ CONTRACTS: { MARKET_FACTORY: '0xC52b8b69d266F9656Be11511907192EaFD521BcB' } }))
vi.mock('../lib/chain', () => ({ TARGET_CHAIN_ID: 46630 }))

import { useDeploymentCheck } from './useDeploymentCheck'

/** A fresh cache per test, and one client for the life of that test's tree. */
function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

const apiAnswers = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }))

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', 'https://api.test')
  getChainId.mockReset()
  getChainId.mockResolvedValue(CHAIN)
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('useDeploymentCheck', () => {
  it('starts as checking, which does not refuse anything', async () => {
    vi.stubGlobal('fetch', apiAnswers(200, { chainId: CHAIN, factory: FACTORY }))
    const { result } = renderHook(() => useDeploymentCheck(), { wrapper: makeWrapper() })
    expect(result.current.status).toBe('checking')
    await waitFor(() => expect(result.current.status).toBe('verified'))
  })

  it('is verified when the RPC and the API both agree with the build', async () => {
    vi.stubGlobal('fetch', apiAnswers(200, { chainId: CHAIN, factory: FACTORY, profile: 'rhc-testnet' }))
    const { result } = renderHook(() => useDeploymentCheck(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.status).toBe('verified'))
  })

  it('is a mismatch when the API indexes a different factory', async () => {
    vi.stubGlobal('fetch', apiAnswers(200, { chainId: CHAIN, factory: '0x06C567A901275A729BEe9B1cfd0A084aa9D078Cf' }))
    const { result } = renderHook(() => useDeploymentCheck(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.status).toBe('mismatch'))
    expect(result.current.api).toBe('mismatch')
  })

  it('is a mismatch when the configured RPC is on another chain', async () => {
    getChainId.mockResolvedValue(84532)
    vi.stubGlobal('fetch', apiAnswers(200, { chainId: CHAIN, factory: FACTORY }))
    const { result } = renderHook(() => useDeploymentCheck(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.status).toBe('mismatch'))
    expect(result.current.rpc).toBe('mismatch')
  })

  it('treats a 404 from the API as unknown, not as a mismatch', async () => {
    vi.stubGlobal('fetch', apiAnswers(404, { error: 'Not Found' }))
    const { result } = renderHook(() => useDeploymentCheck(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.status).toBe('unverified'))
    expect(result.current.api).toBe('unknown')
    expect(result.current.rpc).toBe('match')
  })

  it('treats a network error from the API as unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down') }))
    const { result } = renderHook(() => useDeploymentCheck(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.status).toBe('unverified'))
  })

  it('treats an RPC that cannot be read as unknown', async () => {
    getChainId.mockRejectedValue(new Error('rpc down'))
    vi.stubGlobal('fetch', apiAnswers(200, { chainId: CHAIN, factory: FACTORY }))
    const { result } = renderHook(() => useDeploymentCheck(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.status).toBe('unverified'))
    expect(result.current.rpc).toBe('unknown')
  })

  it('asks the API at /api/deployment', async () => {
    const f = apiAnswers(200, { chainId: CHAIN, factory: FACTORY })
    vi.stubGlobal('fetch', f)
    const { result } = renderHook(() => useDeploymentCheck(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.status).toBe('verified'))
    expect((f.mock.calls[0] as unknown[])[0]).toBe('https://api.test/api/deployment')
  })
})
