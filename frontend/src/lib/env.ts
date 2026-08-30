/**
 * Runtime env validation - Sprint 4.5.
 *
 * Vite inlines `import.meta.env.*` at build time. A missing var produces an
 * `undefined` that propagates as a runtime "0x" or "0xundefined" address,
 * silently sending wallet calls into the void. We catch that here.
 *
 * Pattern: call `assertEnv()` from main.tsx before the React tree mounts.
 * Throws a typed error that the fallback UI surfaces as a fatal screen.
 */

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

const REQUIRED_STRINGS = [
  'VITE_API_URL',
  'VITE_BASE_RPC_URL',
  'VITE_NETWORK',
] as const

export class MissingEnvError extends Error {
  constructor(readonly missing: string[]) {
    super(`Missing required env vars: ${missing.join(', ')}`)
    this.name = 'MissingEnvError'
  }
}

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/

export function assertEnv(): void {
  const missing: string[] = []
  const env = import.meta.env as Record<string, string | undefined>

  for (const k of REQUIRED_ADDRESSES) {
    const v = env[k]
    if (!v || !ADDR_RE.test(v)) missing.push(`${k} (invalid address)`)
  }
  for (const k of REQUIRED_STRINGS) {
    const v = env[k]
    if (!v || v.length === 0) missing.push(`${k} (empty)`)
  }

  if (missing.length > 0) throw new MissingEnvError(missing)
}
