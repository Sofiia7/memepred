/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NETWORK: 'mainnet' | 'sepolia'
  readonly VITE_BASE_RPC_URL: string
  readonly VITE_USDC_ADDRESS: `0x${string}`
  readonly VITE_MARKET_FACTORY: `0x${string}`
  readonly VITE_ORACLE_RESOLVER: `0x${string}`
  readonly VITE_FEE_DISTRIBUTOR: `0x${string}`
  readonly VITE_REFERRAL_REGISTRY: `0x${string}`
  readonly VITE_BADGE_NFT: `0x${string}`
  readonly VITE_GENESIS_NFT: `0x${string}`
  readonly VITE_LIQUIDITY_POOL: `0x${string}`
  readonly VITE_PYTH_FEED_ID?: string
  readonly VITE_PYTH_HERMES?: string
  readonly VITE_API_URL: string
  readonly VITE_GRAPH_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
