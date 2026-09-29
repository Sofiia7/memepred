import { FastifyInstance } from 'fastify'
import { CHAIN_PROFILE } from '../chainProfile.js'
import { CONTRACTS } from '../config.js'

/**
 * Which deployment this API belongs to, so the frontend can check that it is
 * talking to the one it was built for.
 *
 * Robinhood Chain is redeployed as the contracts change, and a frontend bundle
 * bakes the addresses of ONE deployment in (`VITE_*`). Pointed at an API of
 * another - a stale cache, a preview build, a redeploy that reached one side
 * first - it does not fail: it shows a market list from one stack and sends
 * transactions to the other. Comparing what the bundle believes with what this
 * says is how that becomes an error message instead of a lost stake.
 *
 * Public and cheap on purpose: no database, no Redis, nothing but process
 * configuration that is already public on chain. It carries no secret and never
 * may (no keys, no URLs with credentials, no WORKER_SECRET). It goes through the
 * same edge proof and rate limit as every other /api route - it is deliberately
 * NOT on the edge-exempt list: the point of it is a frontend reading it through
 * the worker, and exempting it would only widen the origin's public surface.
 */
export interface DeploymentInfo {
  chainId: number
  profile: string
  /** All addresses lower-case; null when the deployment does not configure one. */
  factory: string | null
  resolver: string | null
  liquidityPool: string | null
  /** The token stakes are denominated in (WETH on rhc, USDC on Base). */
  stakeToken: string | null
  /** First block the indexer reads from, when the environment sets it. */
  indexerStartBlock: number | null
  /** The commit this build came from, when the deploy sets GIT_COMMIT. */
  commit: string | null
}

const address = (a: string | undefined | null): string | null =>
  a && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null

export function readDeployment(env: NodeJS.ProcessEnv = process.env): DeploymentInfo {
  const start = env.INDEXER_START_BLOCK?.trim()
  const startBlock = start ? Number(start) : NaN
  const commit = env.GIT_COMMIT?.trim()
  return {
    chainId: CHAIN_PROFILE.chain.id,
    profile: CHAIN_PROFILE.name,
    factory: address(CONTRACTS.MARKET_FACTORY),
    resolver: address(CONTRACTS.ORACLE_RESOLVER),
    liquidityPool: address(CONTRACTS.LIQUIDITY_POOL),
    stakeToken: address(CONTRACTS.USDC),
    indexerStartBlock: Number.isSafeInteger(startBlock) && startBlock >= 0 ? startBlock : null,
    commit: commit ? commit.slice(0, 64) : null,
  }
}

interface Opts {
  /** Injected in tests. */
  read?: () => DeploymentInfo
}

export async function deploymentRoutes(app: FastifyInstance, opts: Opts = {}) {
  const read = opts.read ?? (() => readDeployment())

  app.get('/api/deployment', async (_req, reply) => {
    // It changes only when the process is redeployed, so 30s is generous and
    // lets the edge answer most of a page-load stampede.
    reply.header('Cache-Control', 'public, max-age=30')
    return read()
  })
}
