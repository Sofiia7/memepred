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
 * VITE_NETWORK selects, and it is a strict enum: `mainnet` (Base mainnet),
 * `sepolia` (Base Sepolia), `rhc` (Robinhood Chain) or `rhc-testnet`. An
 * unrecognised value is refused by assertEnv() with a fatal screen instead of
 * quietly becoming Base Sepolia - a typo in a deployment's environment must
 * not put a Robinhood site on the wrong chain, with the wrong currency.
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

export const NETWORK_NAMES = ['mainnet', 'sepolia', 'rhc', 'rhc-testnet'] as const
export type NetworkName = (typeof NETWORK_NAMES)[number]

export interface Deployment {
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

/**
 * Strict parse of a VITE_NETWORK value. Case and surrounding whitespace are
 * forgiven (a pasted value with a trailing newline or a BOM is still
 * unambiguous); anything else that is not a member of the enum is undefined.
 */
export function parseNetwork(value: string | undefined | null): NetworkName | undefined {
  const key = (value ?? '').trim().toLowerCase()
  return (NETWORK_NAMES as readonly string[]).includes(key) ? (key as NetworkName) : undefined
}

export class UnknownNetworkError extends Error {
  constructor(readonly value: string | undefined) {
    super(
      `VITE_NETWORK must be one of ${NETWORK_NAMES.join(', ')}, ` +
        `got ${value === undefined || value === '' ? 'nothing' : JSON.stringify(value)}`,
    )
    this.name = 'UnknownNetworkError'
  }
}

/** Throws UnknownNetworkError for anything that is not a member of the enum. */
export function resolveDeployment(network: string | undefined): Deployment {
  const key = parseNetwork(network)
  if (!key) throw new UnknownNetworkError(network)
  return DEPLOYMENTS[key]
}

/**
 * The value the rest of the app is built on, resolved when this module loads.
 *
 * It must not throw here: main.tsx renders its fatal config screen only after
 * its imports have evaluated, and this module is one of them. So an invalid
 * VITE_NETWORK evaluates to a placeholder (Base Sepolia, the app's oldest
 * default) purely so the module graph can load - and assertEnv(), the first
 * thing main.tsx runs, rejects that same value before anything mounts. The
 * placeholder is never rendered.
 */
export const DEPLOYMENT = DEPLOYMENTS[parseNetwork(import.meta.env.VITE_NETWORK) ?? 'sepolia']

/** Single source of truth for "the chain this app runs on". */
export const TARGET_CHAIN = DEPLOYMENT.chain
export const TARGET_CHAIN_ID = TARGET_CHAIN.id
export const CURRENCY = DEPLOYMENT.currency
export const IS_POOL_BACKED = DEPLOYMENT.poolBacked
