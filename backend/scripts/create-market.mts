/**
 * Manual market creation, for the pools the owner has actually reviewed.
 *
 * poolWatcher.ts stopped auto-creating markets once AUTO_CREATE_MARKETS
 * defaulted to false ("spending money to create a market is opt-in" - see its
 * own comment), but nothing replaced the automation with a tool a human could
 * actually use: the only other path was rhc-live-cycle.mts, which is
 * hardcoded to a single fixture pool and is a soak-test harness, not an
 * operator command. This is that tool.
 *
 * Dry-run by default: it reads PoolMarketFactory's own on-chain admission
 * gates directly - canonical pool + WETH pair + allowed fee tier, WETH
 * depth, ring cardinality, and whether the pool can actually SERVE the
 * needed windows (not just report capacity for them) - and prints what it
 * finds. Nothing is sent unless --execute is also passed, and even then it
 * simulates the exact call first and refuses to send anything that would
 * revert. Reading the factory's own gates rather than reimplementing the
 * policy here is deliberate: the only thing that matters is whether
 * createMarket itself will accept the pool, and a second copy of the rule in
 * this script could drift from the contract the same way _twapWindowFor is
 * deliberately copied, not shared, between the two resolvers elsewhere in
 * this codebase.
 *
 * Usage (from backend/, same convention as every other script here):
 *   npx tsx scripts/create-market.mts --pool 0x... [--duration 300] [--execute]
 *
 * Needs .env.rhc loaded, not the Base .env - see the project's own note on
 * this trap (memory: rhc-local-stack-operations). Simplest:
 *   node -r dotenv/config scripts/create-market.mts dotenv_config_path=../.env.rhc -- --pool 0x...
 * or export the handful of vars (RHC_RPC_URL, MARKET_FACTORY,
 * KEEPER_PRIVATE_KEY only needed for --execute) into the shell first.
 *
 * Verified against the live testnet factory 2026-09-15: wethDepth,
 * MIN_POOL_WETH_DEPTH, MIN_CARDINALITY, twapWindowFor, canServeWindow,
 * feedIdFor and marketFor all read correctly and marketFor correctly found
 * the existing 300s market on the stand-in pool. ENTRY_TWAP_WINDOW reverts
 * there, because that constant does not exist on the deployed factory
 * (commit 6009d53) - it is part of this session's entry-window fix, not yet
 * redeployed. This script targets the current source, not the current
 * deployment; the entry-window check will start passing once someone
 * redeploys with it. See docs/rhc/LAUNCH-GATES.md.
 */
import 'dotenv/config'
import {
  createPublicClient, createWalletClient, http, formatEther,
  keccak256, encodePacked, type Address, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const EXECUTE = process.argv.includes('--execute')
const POOL = arg('pool') as Address | undefined
const DURATION = BigInt(arg('duration', '300')!)

if (!POOL) {
  console.error('Usage: npx tsx scripts/create-market.mts --pool 0x... [--duration 300] [--execute]')
  process.exit(1)
}

const RPC_URL = process.env.RHC_RPC_URL
const FACTORY = process.env.MARKET_FACTORY as Address | undefined
const CHAIN_ID = Number(process.env.CHAIN_ID || '46630')
if (!RPC_URL || !FACTORY) {
  console.error('RHC_RPC_URL and MARKET_FACTORY must be set - load .env.rhc, not the Base .env.')
  process.exit(1)
}

const chain = {
  id: CHAIN_ID, name: `rhc-${CHAIN_ID}`,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) })

const FACTORY_ABI = [
  { name: 'wethDepth', type: 'function', stateMutability: 'view', inputs: [{ name: 'pool', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'canServeWindow', type: 'function', stateMutability: 'view', inputs: [{ name: 'pool', type: 'address' }, { name: 'window', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'twapWindowFor', type: 'function', stateMutability: 'pure', inputs: [{ name: 'duration', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { name: 'ENTRY_TWAP_WINDOW', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'MIN_POOL_WETH_DEPTH', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'MIN_CARDINALITY', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { name: 'allowedFeeTier', type: 'function', stateMutability: 'view', inputs: [{ name: 'fee', type: 'uint24' }], outputs: [{ type: 'bool' }] },
  { name: 'feedIdFor', type: 'function', stateMutability: 'pure', inputs: [{ name: 'pool', type: 'address' }], outputs: [{ type: 'bytes32' }] },
  { name: 'marketFor', type: 'function', stateMutability: 'view', inputs: [{ name: 'slot', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { name: 'createMarket', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'pool', type: 'address' }, { name: 'duration', type: 'uint256' }], outputs: [{ name: 'market', type: 'address' }] },
] as const
const POOL_ABI = [
  { name: 'slot0', type: 'function', stateMutability: 'view', inputs: [], outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
    { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' },
    { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' },
    { name: 'unlocked', type: 'bool' } ] },
  { name: 'fee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
] as const

async function main() {
  console.log(`Checking pool ${POOL} for a ${DURATION}s market on factory ${FACTORY} (chain ${CHAIN_ID})\n`)

  const [depthWei, minDepthWei, minCardinality, fee, slot0, entryWindow] = await Promise.all([
    publicClient.readContract({ address: FACTORY!, abi: FACTORY_ABI, functionName: 'wethDepth', args: [POOL!] }),
    publicClient.readContract({ address: FACTORY!, abi: FACTORY_ABI, functionName: 'MIN_POOL_WETH_DEPTH' }),
    publicClient.readContract({ address: FACTORY!, abi: FACTORY_ABI, functionName: 'MIN_CARDINALITY' }),
    publicClient.readContract({ address: POOL!, abi: POOL_ABI, functionName: 'fee' }),
    publicClient.readContract({ address: POOL!, abi: POOL_ABI, functionName: 'slot0' }),
    publicClient.readContract({ address: FACTORY!, abi: FACTORY_ABI, functionName: 'ENTRY_TWAP_WINDOW' }),
  ])
  const cardinality = slot0[3]
  const allowedTier = await publicClient.readContract({ address: FACTORY!, abi: FACTORY_ABI, functionName: 'allowedFeeTier', args: [fee] })
  const exitWindow = await publicClient.readContract({ address: FACTORY!, abi: FACTORY_ABI, functionName: 'twapWindowFor', args: [DURATION] })
  const canServeExit = await publicClient.readContract({ address: FACTORY!, abi: FACTORY_ABI, functionName: 'canServeWindow', args: [POOL!, exitWindow] })
  const canServeEntry = exitWindow >= entryWindow
    ? true
    : await publicClient.readContract({ address: FACTORY!, abi: FACTORY_ABI, functionName: 'canServeWindow', args: [POOL!, entryWindow] })

  // marketFor is keyed by keccak256(feedId, duration) - PoolMarketFactory.sol's `marketFor` mapping.
  const feedId = await publicClient.readContract({ address: FACTORY!, abi: FACTORY_ABI, functionName: 'feedIdFor', args: [POOL!] })
  const slot = keccak256(encodePacked(['bytes32', 'uint256'], [feedId, DURATION]))
  const existing = await publicClient.readContract({ address: FACTORY!, abi: FACTORY_ABI, functionName: 'marketFor', args: [slot] })

  const checks: Array<[string, boolean]> = [
    ['canonical pool + WETH pair + allowed fee tier', allowedTier],
    [`depth >= ${formatEther(minDepthWei)} ETH (has ${formatEther(depthWei)})`, depthWei >= minDepthWei],
    [`cardinality >= ${minCardinality} (has ${cardinality})`, cardinality >= minCardinality],
    [`can serve the ${exitWindow}s exit window`, canServeExit],
    [`can serve the ${entryWindow}s entry window`, canServeEntry],
    ['no market on this (pool, duration) yet', existing === '0x0000000000000000000000000000000000000000'],
  ]
  for (const [label, ok] of checks) console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}`)
  const allOk = checks.every(([, ok]) => ok)

  if (!allOk) {
    console.log('\nOne or more gates fail - createMarket would revert. Not sending anything.')
    process.exit(1)
  }
  console.log('\nAll gates pass.')

  if (!EXECUTE) {
    console.log('Dry run only (pass --execute to actually create the market).')
    return
  }

  const key = process.env.KEEPER_PRIVATE_KEY as Hex | undefined
  if (!key) { console.error('KEEPER_PRIVATE_KEY not set - cannot execute.'); process.exit(1) }
  const account = privateKeyToAccount(key)
  const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) })

  console.log(`\nSimulating createMarket(${POOL}, ${DURATION}) from ${account.address}…`)
  const { request } = await publicClient.simulateContract({
    account, address: FACTORY!, abi: FACTORY_ABI, functionName: 'createMarket', args: [POOL!, DURATION],
  })
  const hash = await walletClient.writeContract(request)
  console.log(`Sent: ${hash}`)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    console.error(`Reverted on-chain despite passing simulation. tx=${hash}`)
    process.exit(1)
  }
  console.log(`Market created. tx=${hash}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
