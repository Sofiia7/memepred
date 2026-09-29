/**
 * Does this build describe the same deployment as the API it talks to?
 *
 * A frontend is built against a set of contract addresses and one chain id; the
 * backend indexes a factory on a chain. Nothing used to check that the two
 * agree, so a Robinhood site pointed at the wrong RPC, or at an API that had
 * been redeployed with a new factory, would list markets from one deployment
 * and offer to sign transactions against another (audit U11).
 *
 * Two independent questions, asked of two independent sources:
 *
 *   rpc  eth_chainId from the configured RPC        vs  the chain this build targets
 *   api  GET /api/deployment {chainId, factory, ...} vs  the chain and factory this build targets
 *
 * A source that cannot answer (a 404 from an API that has not shipped the
 * endpoint yet, a network error, a timeout) is "unknown", never a mismatch:
 * refusing to sign because a health endpoint is down would make the check a
 * new way for the site to break. Only a definite disagreement refuses.
 */

export type SourceVerdict = 'match' | 'mismatch' | 'unknown'

export interface DeploymentVerdict {
  /**
   *   checking    nothing has answered yet
   *   verified    both sources answered and agree
   *   unverified  no disagreement, but at least one source could not be asked
   *   mismatch    a source definitely disagrees; signing must be refused
   */
  status: 'checking' | 'verified' | 'unverified' | 'mismatch'
  rpc: SourceVerdict
  api: SourceVerdict
  /** Short, human-readable, for the banner and for diagnosing a wrong build. */
  reasons: string[]
}

/** What GET /api/deployment returns. Only the fields this check compares are read. */
export interface ApiDeployment {
  chainId?: number
  factory?: string
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/

/** How long the API is given to answer before it counts as "unknown". */
export const DEPLOYMENT_TIMEOUT_MS = 8_000

/**
 * The fields of an API answer that can be compared, or null when there is
 * nothing usable in it. A malformed field is ignored rather than treated as a
 * mismatch: the API being confused about its own answer is not evidence that
 * this build is wrong.
 */
export function parseApiDeployment(json: unknown): ApiDeployment | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  const out: ApiDeployment = {}

  const rawChain = o.chainId
  const chainId = typeof rawChain === 'number' ? rawChain : typeof rawChain === 'string' && /^\d+$/.test(rawChain) ? Number(rawChain) : NaN
  if (Number.isSafeInteger(chainId) && chainId > 0) out.chainId = chainId

  if (typeof o.factory === 'string' && ADDR_RE.test(o.factory)) out.factory = o.factory

  return out.chainId === undefined && out.factory === undefined ? null : out
}

/**
 * GET {apiBase}/api/deployment. Resolves null for anything but a readable 2xx:
 * a 404 (endpoint not deployed), another error status, a network failure, a
 * timeout, a body that is not JSON.
 */
export async function fetchDeployment(apiBase: string, fetchImpl: typeof fetch = fetch): Promise<ApiDeployment | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEPLOYMENT_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${apiBase}/api/deployment`, { signal: controller.signal })
    if (!res.ok) return null
    return parseApiDeployment(await res.json())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface DeploymentInput {
  expectedChainId: number
  expectedFactory: string
  /** eth_chainId of the configured RPC; null/undefined when it could not be read. */
  rpcChainId?: number | null
  /** The API's answer; null/undefined when it could not be had. */
  api?: ApiDeployment | null
}

export function evaluateDeployment(i: DeploymentInput): DeploymentVerdict {
  const reasons: string[] = []

  let rpc: SourceVerdict = 'unknown'
  if (typeof i.rpcChainId === 'number') {
    if (i.rpcChainId === i.expectedChainId) {
      rpc = 'match'
    } else {
      rpc = 'mismatch'
      reasons.push(`The configured RPC is on chain ${i.rpcChainId}, this site is built for chain ${i.expectedChainId}.`)
    }
  }

  let api: SourceVerdict = 'unknown'
  if (i.api) {
    let disagrees = false
    let compared = false
    if (i.api.chainId !== undefined) {
      compared = true
      if (i.api.chainId !== i.expectedChainId) {
        disagrees = true
        reasons.push(`The API serves chain ${i.api.chainId}, this site is built for chain ${i.expectedChainId}.`)
      }
    }
    if (i.api.factory !== undefined) {
      compared = true
      if (i.api.factory.toLowerCase() !== i.expectedFactory.toLowerCase()) {
        disagrees = true
        reasons.push('The API indexes a different market factory than the one this site is built for.')
      }
    }
    api = disagrees ? 'mismatch' : compared ? 'match' : 'unknown'
  }

  const status: DeploymentVerdict['status'] =
    rpc === 'mismatch' || api === 'mismatch' ? 'mismatch' : rpc === 'match' && api === 'match' ? 'verified' : 'unverified'

  return { status, rpc, api, reasons }
}

/** What the banner and the Composer say on a definite mismatch. */
export const DEPLOYMENT_MISMATCH_MESSAGE = 'This site is configured for a different deployment than its API'
