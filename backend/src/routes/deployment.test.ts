import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'

/**
 * GET /api/deployment: which deployment this API is, for the frontend to check
 * itself against. Public and cheap, so what matters is what it says, what it
 * never says, and that it sits behind the same gates as the rest of /api.
 */

const FACTORY = '0xC52b8b69d266F9656Be11511907192EaFD521BcB'
const state = vi.hoisted(() => ({ contracts: {} as Record<string, string> }))

vi.mock('../chainProfile.js', () => ({
  CHAIN_PROFILE: { name: 'rhc', chain: { id: 46630 } },
}))
vi.mock('../config.js', () => ({
  get CONTRACTS() { return state.contracts },
}))

const { deploymentRoutes, readDeployment } = await import('./deployment.js')
const { registerHttpPlugins, DEFAULT_ORIGINS } = await import('../lib/httpPlugins.js')

const SECRET = 'worker-secret-for-tests'

function configured() {
  state.contracts = {
    MARKET_FACTORY:  FACTORY,
    ORACLE_RESOLVER: '0x1111111111111111111111111111111111111111',
    LIQUIDITY_POOL:  '0x06C5AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',
    USDC:            '0x0BD7D308F8E1639FAB988DAAED53D6B6091E3B77',
    FEE_DISTRIBUTOR: '0x2222222222222222222222222222222222222222', // never reported
  }
}

describe('readDeployment', () => {
  it('reports the chain, the profile and the addresses, lower-cased', () => {
    configured()
    const d = readDeployment({ INDEXER_START_BLOCK: '1234567', GIT_COMMIT: 'abc1234def' } as any)
    expect(d).toEqual({
      chainId: 46630,
      profile: 'rhc',
      factory: FACTORY.toLowerCase(),
      resolver: '0x1111111111111111111111111111111111111111',
      liquidityPool: '0x06c5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      stakeToken: '0x0bd7d308f8e1639fab988daaed53d6b6091e3b77',
      indexerStartBlock: 1234567,
      commit: 'abc1234def',
    })
  })

  it('says null for what is not configured rather than inventing it', () => {
    state.contracts = { MARKET_FACTORY: '0x', ORACLE_RESOLVER: '0x', LIQUIDITY_POOL: '0x', USDC: '0x' }
    const d = readDeployment({} as any)
    expect(d.factory).toBeNull()
    expect(d.resolver).toBeNull()
    expect(d.liquidityPool).toBeNull()
    expect(d.stakeToken).toBeNull()
    expect(d.indexerStartBlock).toBeNull()
    expect(d.commit).toBeNull()
  })

  it('ignores a start block or commit that is blank or nonsense', () => {
    configured()
    expect(readDeployment({ INDEXER_START_BLOCK: 'latest', GIT_COMMIT: '   ' } as any)).toMatchObject({
      indexerStartBlock: null, commit: null,
    })
    expect(readDeployment({ INDEXER_START_BLOCK: '-5' } as any).indexerStartBlock).toBeNull()
  })

  it('carries no secret and no address it was not asked to publish', () => {
    configured()
    const d = readDeployment({
      WORKER_SECRET: 'top-secret', KEEPER_PRIVATE_KEY: '0xdeadbeef', DATABASE_URL: 'postgres://u:p@h/db',
      GIT_COMMIT: 'abc',
    } as any)
    const text = JSON.stringify(d)
    expect(text).not.toContain('top-secret')
    expect(text).not.toContain('deadbeef')
    expect(text).not.toContain('postgres')
    expect(text).not.toContain('2222222222222222222222222222222222222222') // the fee distributor is not part of it
    expect(Object.keys(d).sort()).toEqual([
      'chainId', 'commit', 'factory', 'indexerStartBlock', 'liquidityPool', 'profile', 'resolver', 'stakeToken',
    ])
  })
})

async function build(over: { workerSecret?: string | undefined; rateLimitMax?: number } = {}) {
  const app = Fastify()
  await registerHttpPlugins(app, {
    corsOrigins: DEFAULT_ORIGINS,
    workerSecret: SECRET,
    rateLimitMax: 100,
    markActivity: async () => {},
    ...over,
  })
  await app.register(deploymentRoutes)
  await app.ready()
  return app
}

describe('GET /api/deployment', () => {
  it('answers with the deployment, cacheable for 30 seconds', async () => {
    configured()
    const app = await build()
    const res = await app.inject({ url: '/api/deployment', headers: { 'x-worker-secret': SECRET } })

    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=30')
    expect(res.json()).toMatchObject({ chainId: 46630, profile: 'rhc', factory: FACTORY.toLowerCase() })
    await app.close()
  })

  it('is behind the edge proof like every other /api route: no secret, no answer', async () => {
    configured()
    const app = await build()

    expect((await app.inject({ url: '/api/deployment' })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/deployment', headers: { 'x-worker-secret': 'forged' } })).statusCode).toBe(403)
    await app.close()
  })

  it('is behind the rate limit like every other /api route', async () => {
    configured()
    const app = await build({ rateLimitMax: 2 })
    const headers = { 'x-worker-secret': SECRET }

    expect((await app.inject({ url: '/api/deployment', headers })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/deployment', headers })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/deployment', headers })).statusCode).toBe(429)
    await app.close()
  })

  it('serves without a secret only where nothing else is enforced either (local development)', async () => {
    configured()
    const app = await build({ workerSecret: undefined })
    expect((await app.inject({ url: '/api/deployment' })).statusCode).toBe(200)
    await app.close()
  })
})
