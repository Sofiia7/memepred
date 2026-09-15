import { defineChain } from 'viem'
import { base, baseSepolia } from 'wagmi/chains'
import type { Chain } from 'viem'

/**
 * Which chain this build targets, and what the stake is denominated in.
 *
 * The mirror of backend/src/chainProfile.ts, and it exists for the same
 * reason: the currency's width is a property of the deployment, not a literal
 * to repeat. Six of them were spread across formatUnits and parseUnits calls,
 * which is fine while stakes are six-decimal USDC and a million times wrong
 * the moment they are eighteen-decimal WETH.
 *
 * VITE_NETWORK selects. `mainnet` still means Base mainnet and anything
 * unrecognised still means Base Sepolia, so an existing build is unaffected.
 */
export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
})

export const robinhoodChainTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  // Was robinhoodchain.blockscout.com - that's mainnet 4663's explorer.
  // Testnet 46630 has its own, confirmed in docs/rhc/DEPLOYMENTS.md.
  blockExplorers: { default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' } },
  testnet: true,
})

export interface CurrencyConfig {
  decimals: number
  symbol: string
  /**
   * Stake bounds, mirroring the market contract's MIN_BET/MAX_BET. Held here
   * rather than read on chain because they are contract constants rather than
   * per-market state, and the UI wants them to clamp input before a user
   * submits a transaction that is guaranteed to revert.
   */
  minBet: string
  maxBet: string
  /** How many decimals to show. Cents for a dollar; more for a fraction of ETH. */
  displayDecimals: number
}

const USDC: CurrencyConfig = {
  decimals: 6,
  symbol: 'USDC',
  minBet: '1',
  maxBet: '100',
  displayDecimals: 2,
}

/** PoolOrderbookMarket's overrides: 0.005 / 0.04 ETH, derived from gas. */
const WETH: CurrencyConfig = {
  decimals: 18,
  symbol: 'WETH',
  minBet: '0.005',
  maxBet: '0.04',
  displayDecimals: 4,
}

export type NetworkName = 'mainnet' | 'sepolia' | 'rhc' | 'rhc-testnet'

interface Deployment {
  network: NetworkName
  chain: Chain
  currency: CurrencyConfig
  /**
   * Whether markets are pool-backed, i.e. whether the UI should talk about
   * pools and TWAP manipulation rather than about a price feed.
   */
  poolBacked: boolean
}

const DEPLOYMENTS: Record<NetworkName, Deployment> = {
  mainnet:       { network: 'mainnet',      chain: base,                  currency: USDC, poolBacked: false },
  sepolia:       { network: 'sepolia',      chain: baseSepolia,           currency: USDC, poolBacked: false },
  rhc:           { network: 'rhc',          chain: robinhoodChain,        currency: WETH, poolBacked: true  },
  'rhc-testnet': { network: 'rhc-testnet',  chain: robinhoodChainTestnet, currency: WETH, poolBacked: true  },
}

export function resolveDeployment(network: string | undefined): Deployment {
  const key = (network ?? '').trim().toLowerCase()
  if (key in DEPLOYMENTS) return DEPLOYMENTS[key as NetworkName]
  // Unrecognised falls back to Base Sepolia, which is what this app did before
  // there was more than one chain to choose from.
  return DEPLOYMENTS.sepolia
}

export const DEPLOYMENT = resolveDeployment(import.meta.env.VITE_NETWORK)

/** Single source of truth for "the chain this app runs on". */
export const TARGET_CHAIN = DEPLOYMENT.chain
export const TARGET_CHAIN_ID = TARGET_CHAIN.id
export const CURRENCY = DEPLOYMENT.currency
export const IS_POOL_BACKED = DEPLOYMENT.poolBacked
