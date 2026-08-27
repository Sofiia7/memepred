/**
 * End-to-end proof that the RedStone path works against live contracts.
 *
 *   cd backend && node scripts/smoke-redstone.mjs
 *
 * Fetches a real payload from the public gateway, pushes it through
 * OracleResolver.recordPrice as the keeper, and reads the stored price back.
 * That exercises every piece the migration touched at once: the keyless
 * gateway fetch, the 3-of-5 signature check inside our own contract, the
 * calldata-suffix calling convention, and the 8-decimals-to-1e18 conversion
 * that would otherwise scale every strike by ten billion.
 */
import { createPublicClient, createWalletClient, http, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { readFileSync } from 'node:fs'
import { fetchPayload, fetchPrice, feedIdToBytes32 } from '../src/lib/redstone.js'

const RESOLVER = process.env.ORACLE_RESOLVER as `0x${string}`
const RPC      = process.env.BASE_RPC_URL ?? 'https://sepolia.base.org'
const SYMBOL   = process.argv[2] ?? 'PEPE'
if (!RESOLVER) throw new Error('set ORACLE_RESOLVER')

const keeperKey = JSON.parse(readFileSync('../.testwallets/keeper.json', 'utf8'))
const pk = Object.entries(keeperKey).find(([k]) => /key/i.test(k))![1] as string
const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`)

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) })
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) })

const feedId = feedIdToBytes32(SYMBOL)

// 1. A real payload, from the public gateway, with no credential. Same call the
//    keeper makes, so a break in the real path cannot pass here.
const payload  = await fetchPayload(SYMBOL)
const expected = await fetchPrice(SYMBOL)
console.log(`${SYMBOL}: gateway says $${expected}, payload ${(payload.length - 2) / 2} bytes`)

// 2. Push it on-chain, price appended to the calldata.
const ABI = [{
  name: 'recordPrice', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'feedId', type: 'bytes32' }], outputs: [],
}, {
  name: 'historyLength', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'feedId', type: 'bytes32' }], outputs: [{ type: 'uint256' }],
}, {
  name: 'priceHistory', type: 'function', stateMutability: 'view',
  inputs: [{ type: 'bytes32' }, { type: 'uint256' }],
  outputs: [{ name: 'price', type: 'uint256' }, { name: 'ts', type: 'uint256' }],
}]

const lengthBefore = await publicClient.readContract({
  address: RESOLVER, abi: ABI, functionName: 'historyLength', args: [feedId],
})

const data = encodeFunctionData({ abi: ABI, functionName: 'recordPrice', args: [feedId] })
const hash = await wallet.sendTransaction({
  to: RESOLVER,
  data: `${data}${payload.slice(2)}`,
  gas: 500_000n,
})
const receipt = await publicClient.waitForTransactionReceipt({ hash })
console.log(`recordPrice: ${receipt.status}, gas ${receipt.gasUsed}, tx ${hash}`)
if (receipt.status !== 'success') process.exit(1)

// 3. Read it back and check the scaling.
//
// Poll rather than read once: the RPC serves state a moment behind the
// receipt, so an immediate read returns the previous entry - which on a second
// run looks like a price mismatch rather than the race it is.
const before = lengthBefore
let n = before
for (let i = 0; i < 20 && n <= before; i++) {
  n = await publicClient.readContract({ address: RESOLVER, abi: ABI, functionName: 'historyLength', args: [feedId] })
  if (n > before) break
  await new Promise((r) => setTimeout(r, 1000))
}
if (n <= before) throw new Error('recordPrice succeeded but no new history entry appeared')
const [price] = await publicClient.readContract({
  address: RESOLVER, abi: ABI, functionName: 'priceHistory', args: [feedId, n - 1n],
})

const asUsd = Number(price) / 1e18
console.log(`stored: ${price} wei = $${asUsd}`)
console.log(`expected $${expected} -> ${asUsd === expected ? 'MATCH' : 'MISMATCH'}`)
process.exit(asUsd === expected ? 0 : 1)
