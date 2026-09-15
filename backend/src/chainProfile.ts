import { defineChain, type Chain } from 'viem'
import { base, baseSepolia } from 'viem/chains'

/**
 * Which chain this process is running against, and what that implies.
 *
 * The two deployments are not the same product wearing different addresses.
 * On Base a price is a signed RedStone payload the keeper pushes every thirty
 * seconds, markets have a close time the keeper invented and roll over on a
 * schedule, and stakes are six-decimal USDC. On Robinhood Chain the price
 * comes out of the token's own Uniswap v3 pool, a market is created once and
 * lives forever, and stakes are eighteen-decimal WETH.
 *
 * Those differences reach into which keeper loops should exist at all, so they
 * are stated here once rather than rediscovered by each loop through a
 * scattering of `if (chainId === ...)`. A loop asks the profile whether it
 * belongs; the assembly in keeper/index.ts asks the same question and simply
 * does not start it.
 *
 * `base` is the default and is byte-for-byte the behaviour that ran before
 * this file existed. Nothing about the Base deployment changes by adding a
 * second profile - that is the constraint the whole branch works under.
 */
export type ChainProfileName = 'base' | 'rhc'

/**
 * Robinhood Chain. Not in viem's registry, so defined here from values read
 * off the chain itself (see docs/rhc/measurements) rather than from docs.
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
  blockExplorers: { default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' } },
  testnet: true,
})

export interface ChainProfile {
  name: ChainProfileName
  chain: Chain
  /**
   * RPC this profile talks to, or undefined to let viem use the chain's own
   * default. Undefined is meaningful rather than lazy: that is exactly what
   * the Base deployment does today when BASE_RPC_URL is unset, and baking in
   * a literal here would silently point Base Sepolia at Base mainnet.
   */
  rpcUrl: string | undefined
  /** Decimals of the token stakes are denominated in. */
  currencyDecimals: number
  currencySymbol: string

  /**
   * Whether the keeper pushes prices on chain.
   *
   * False on rhc, and this is the single largest cost difference between the
   * two: a v3 pool keeps its own observation history, so there is nothing to
   * push and no `priceHistory` array to keep fed.
   */
  pushesPricesOnChain: boolean

  /**
   * Whether markets have a close time and are rolled over on a schedule.
   *
   * False on rhc. Nothing in OrderbookMarket has ever had a close time - a
   * match's settleAt is set when it matches - so the rollover carousel was
   * always keeper policy rather than a contract requirement. On a chain where
   * a clone costs real money, dropping it turns a per-calendar-day cost into a
   * per-trade one.
   */
  rollsOverMarkets: boolean

  /**
   * Whether a price rides on the calldata of every call that needs one.
   *
   * True on base: a RedStone payload is appended to placeBet, recordPrice and
   * every settlement, which is why none of those can be an ordinary
   * writeContract. False on rhc, where the resolver reads the pool itself.
   *
   * Separate from pushesPricesOnChain even though the two agree today: one is
   * about a keeper loop, the other about how any call is encoded, and a future
   * pull oracle that needs no recorder would tell them apart.
   */
  oraclePayloadInCalldata: boolean

  /**
   * Whether the keeper watches PoolCreated and onboards pools itself.
   * The rhc counterpart to a multisig-managed feed whitelist.
   */
  watchesPools: boolean

  /**
   * Whether the execution gas price must be read from ArbGasInfo rather than
   * eth_gasPrice.
   *
   * True on rhc: measured on chain, eth_gasPrice reports 0.45-0.56 gwei while
   * transactions actually execute at perArbGasTotal, around four times that.
   * A gas guard reading the wrong one would never throttle and would never
   * bill correctly either.
   */
  usesArbGasInfo: boolean

  /**
   * Chain-level addresses, as opposed to our own deployments in config.ts.
   * Empty on base, where prices come from a feed rather than a pool.
   */
  addresses: {
    weth?: `0x${string}`
    uniswapV3Factory?: `0x${string}`
    /** ArbGasInfo precompile, where perArbGasTotal is read. */
    arbGasInfo?: `0x${string}`
  }
}

const BASE_PROFILE: ChainProfile = {
  name: 'base',
  chain: process.env.CHAIN_ID === '8453' ? base : baseSepolia,
  rpcUrl: process.env.BASE_RPC_URL,
  currencyDecimals: 6,
  currencySymbol: 'USDC',
  pushesPricesOnChain: true,
  oraclePayloadInCalldata: true,
  rollsOverMarkets: true,
  watchesPools: false,
  usesArbGasInfo: false,
  addresses: {},
}

const RHC_PROFILE: ChainProfile = {
  name: 'rhc',
  chain: process.env.CHAIN_ID === '4663' ? robinhoodChain : robinhoodChainTestnet,
  rpcUrl:
    process.env.RHC_RPC_URL ||
    (process.env.CHAIN_ID === '4663'
      ? 'https://rpc.mainnet.chain.robinhood.com'
      : 'https://rpc.testnet.chain.robinhood.com'),
  currencyDecimals: 18,
  currencySymbol: 'WETH',
  pushesPricesOnChain: false,
  oraclePayloadInCalldata: false,
  rollsOverMarkets: false,
  watchesPools: true,
  usesArbGasInfo: true,
  addresses: {
    // Mainnet values, read off the chain rather than from docs: WETH came from
    // SwapRouter02.WETH9(), the factory from the PoolCreated logs it emits.
    //
    // Overridable because the testnet has neither - both canonical addresses
    // return empty code there, so it runs stand-ins at different addresses.
    // Hardcoding cost an afternoon: poolWatcher listened to 0x1f7d7550 for
    // PoolCreated, that address holds nothing on 46630, and the watcher
    // reported no pools while looking perfectly healthy.
    weth: (process.env.RHC_WETH_ADDRESS as `0x${string}`) ?? '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
    uniswapV3Factory:
      (process.env.RHC_V3_FACTORY_ADDRESS as `0x${string}`) ?? '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
    // A precompile: the same address on every Arbitrum chain.
    arbGasInfo: '0x000000000000000000000000000000000000006c',
  },
}

/**
 * Resolve the profile from the environment.
 *
 * Unknown values throw rather than falling back. A typo in CHAIN_PROFILE that
 * silently selected `base` would point a Robinhood Chain deployment at a
 * RedStone price recorder and a rollover loop, which is a slow and expensive
 * way to find out.
 */
export function resolveChainProfile(name: string | undefined = process.env.CHAIN_PROFILE): ChainProfile {
  const value = (name ?? 'base').trim().toLowerCase()
  if (value === 'base') return BASE_PROFILE
  if (value === 'rhc') return RHC_PROFILE
  throw new Error(`CHAIN_PROFILE must be "base" or "rhc", got ${JSON.stringify(name)}`)
}

export const CHAIN_PROFILE = resolveChainProfile()

/** Convenience for the many places that only need the width of the currency. */
export const CURRENCY_DECIMALS = CHAIN_PROFILE.currencyDecimals

/** One whole unit of the stake currency, in its smallest denomination. */
export const ONE_UNIT = 10n ** BigInt(CHAIN_PROFILE.currencyDecimals)
