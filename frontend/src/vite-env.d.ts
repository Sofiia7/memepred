/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Strict enum (see lib/chain and lib/env): `mainnet` and `sepolia` are Base,
   * `rhc` and `rhc-testnet` are Robinhood Chain. Anything else makes the app
   * show its fatal config screen instead of picking a default chain.
   */
  readonly VITE_NETWORK: 'mainnet' | 'sepolia' | 'rhc' | 'rhc-testnet'
  /** Required by Base builds (mainnet, sepolia). */
  readonly VITE_BASE_RPC_URL?: string
  /** Required by Robinhood Chain builds (rhc, rhc-testnet). */
  readonly VITE_RHC_RPC_URL?: string
  readonly VITE_USDC_ADDRESS: `0x${string}`
  readonly VITE_MARKET_FACTORY: `0x${string}`
  readonly VITE_ORACLE_RESOLVER: `0x${string}`
  readonly VITE_FEE_DISTRIBUTOR: `0x${string}`
  readonly VITE_REFERRAL_REGISTRY: `0x${string}`
  readonly VITE_BADGE_NFT: `0x${string}`
  readonly VITE_GENESIS_NFT: `0x${string}`
  readonly VITE_LIQUIDITY_POOL: `0x${string}`
  readonly VITE_PYTH_FEED_ID?: string
  readonly VITE_API_URL: string
  /** "1" skips the region check (previews and local dev without a Worker). */
  readonly VITE_DISABLE_GEOBLOCK?: string
  /**
   * Comma-separated ISO codes this deployment has opened, e.g. "SG". The
   * frontend half of the Worker's GEO_OPEN_COUNTRIES: same codes on both
   * sides. Only GB, FR, DE, NL, CA, AU, JP and SG can be opened (see
   * lib/restrictedRegions); unset keeps the full list.
   */
  readonly VITE_GEO_OPEN_COUNTRIES?: string
  /**
   * Exactly "1" switches the whole restricted list off for this build, the
   * U.S. and Tor included: the frontend half of the Worker's
   * GEO_OPEN_ALL_RESTRICTED, for a testnet demo only. The OFAC countries stay
   * blocked. Takes precedence over VITE_GEO_OPEN_COUNTRIES.
   */
  readonly VITE_GEO_OPEN_ALL_RESTRICTED?: string
  /** Faucet link shown to a testnet wallet with no ETH. Defaults in lib/env. */
  readonly VITE_FAUCET_URL?: string
  /**
   * Public origin of this build, e.g. https://rhc.flipthememe.com. Used at
   * build time for og:url and the preview image on Robinhood Chain builds.
   */
  readonly VITE_SITE_URL?: string
  readonly VITE_SECURITY_CONTACT?: string
  /** "1" shows the rounds screen (/rounds and its tab). Off otherwise. See frontend/src/rounds/roundsAbi.ts. */
  readonly VITE_ROUNDS_ENABLED?: string
  /** PoolRounds address on this build's chain. Needed only with VITE_ROUNDS_ENABLED=1. */
  readonly VITE_POOL_ROUNDS_ADDRESS?: string
  /** Optional: PoolRounds deployment block; log scans start here (default 0). */
  readonly VITE_ROUNDS_DEPLOY_BLOCK?: string
  /** Optional: candidate round lengths in seconds, e.g. "300,900" (default). */
  readonly VITE_ROUNDS_DURATIONS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
