/**
 * Runtime env validation - Sprint 4.5, tightened 2026-09-29 (audit U11).
 *
 * Vite inlines `import.meta.env.*` at build time. A missing var produces an
 * `undefined` that propagates as a runtime "0x" or "0xundefined" address,
 * silently sending wallet calls into the void. We catch that here.
 *
 * Pattern: call `assertEnv()` from main.tsx before the React tree mounts.
 * Throws a typed error that the fallback UI surfaces as a fatal screen.
 *
 * What is required depends on which network the build targets, because the two
 * families of deployment do not share an RPC: a Base build reads
 * VITE_BASE_RPC_URL, a Robinhood Chain build reads VITE_RHC_RPC_URL and has no
 * use for the Base one. VITE_NETWORK itself is a strict enum (see lib/chain) -
 * an unrecognised value is an error here, not a silent default.
 */
import { NETWORK_NAMES, parseNetwork, type NetworkName } from './chain'

const REQUIRED_ADDRESSES = [
  'VITE_USDC_ADDRESS',
  'VITE_MARKET_FACTORY',
  'VITE_ORACLE_RESOLVER',
  'VITE_FEE_DISTRIBUTOR',
  'VITE_REFERRAL_REGISTRY',
  'VITE_BADGE_NFT',
  'VITE_LIQUIDITY_POOL',
  'VITE_GENESIS_NFT',
] as const

/** The RPC endpoint variable each network reads. The other family's is not required. */
export const RPC_VAR_BY_NETWORK: Record<NetworkName, 'VITE_BASE_RPC_URL' | 'VITE_RHC_RPC_URL'> = {
  mainnet: 'VITE_BASE_RPC_URL',
  sepolia: 'VITE_BASE_RPC_URL',
  rhc: 'VITE_RHC_RPC_URL',
  'rhc-testnet': 'VITE_RHC_RPC_URL',
}

export class MissingEnvError extends Error {
  constructor(readonly missing: string[]) {
    super(`Missing or invalid env vars: ${missing.join(', ')}`)
    this.name = 'MissingEnvError'
  }
}

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/

/** An absolute http(s) URL. viem's http() transport needs one; `/rpc` would not work. */
export function isHttpUrl(value: string | undefined | null): boolean {
  if (!value) return false
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

type EnvLike = Record<string, string | undefined>

/**
 * Every problem with an env, as short human-readable lines. Empty means fine.
 * Pure so the rules can be tested without a build.
 */
export function validateEnv(env: EnvLike): string[] {
  const problems: string[] = []

  const rawNetwork = env.VITE_NETWORK
  const network = parseNetwork(rawNetwork)
  if (!rawNetwork || rawNetwork.trim().length === 0) {
    problems.push('VITE_NETWORK (empty)')
  } else if (!network) {
    problems.push(
      `VITE_NETWORK (must be one of ${NETWORK_NAMES.join(', ')}; got ${JSON.stringify(rawNetwork)})`,
    )
  }

  for (const k of REQUIRED_ADDRESSES) {
    const v = env[k]
    if (!v || !ADDR_RE.test(v)) problems.push(`${k} (invalid address)`)
  }

  const api = env.VITE_API_URL
  if (!api || api.length === 0) problems.push('VITE_API_URL (empty)')

  // Only when the network is known: an unknown one already has its own line,
  // and guessing which RPC it "would have" read would only add noise.
  if (network) {
    const rpcVar = RPC_VAR_BY_NETWORK[network]
    const rpc = env[rpcVar]
    if (!rpc || rpc.length === 0) {
      problems.push(`${rpcVar} (empty; required for VITE_NETWORK=${network})`)
    } else if (!isHttpUrl(rpc)) {
      problems.push(`${rpcVar} (must be an absolute http(s) URL)`)
    }
  }

  return problems
}

export function assertEnv(env: EnvLike = import.meta.env as EnvLike): void {
  const problems = validateEnv(env)
  if (problems.length > 0) throw new MissingEnvError(problems)
}

// ── optional, but read in more than one place ────────────────────────────

/** Where a fresh testnet wallet gets ETH when VITE_FAUCET_URL is not set. */
export const DEFAULT_FAUCET_URL = 'https://ethfaucet.com/networks/robinhood/robinhood-testnet'

/**
 * The faucet link shown to a wallet with no ETH. Falls back to the default
 * for a missing or non-http(s) value, so a misconfigured variable can never
 * turn the link into something a browser would treat as a script.
 */
export function resolveFaucetUrl(raw: string | undefined | null): string {
  const v = (raw ?? '').trim()
  return isHttpUrl(v) ? v : DEFAULT_FAUCET_URL
}

export const FAUCET_URL = resolveFaucetUrl(import.meta.env.VITE_FAUCET_URL)
