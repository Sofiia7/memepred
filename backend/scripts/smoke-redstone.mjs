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
import proto from '@redstone-finance/protocol'

const { SignedDataPackage, RedstonePayload, recoverDeserializedSignerAddress } = proto

const SIGNERS = [
  '0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774',
  '0xdEB22f54738d54976C4c0fe5ce6d408E40d88499',
  '0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202',
  '0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE',
  '0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de',
].map((a) => a.toLowerCase())

const RESOLVER = process.env.ORACLE_RESOLVER
const RPC      = process.env.BASE_RPC_URL || 'https://sepolia.base.org'
const SYMBOL   = process.argv[2] || 'PEPE'

if (!RESOLVER) throw new Error('set ORACLE_RESOLVER')

const keeperKey = JSON.parse(readFileSync('../.testwallets/keeper.json', 'utf8'))
const pk = Object.entries(keeperKey).find(([k]) => /key/i.test(k))[1]
const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`)

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) })
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) })

const feedId = `0x${Buffer.from(SYMBOL, 'utf8').toString('hex').padEnd(64, '0')}`

// 1. A real payload, from the public gateway, with no credential.
const res = await fetch(
  'https://oracle-gateway-1.a.redstone.finance/v2/data-packages/latest/redstone-primary-prod',
)
const authorised = (await res.json())[SYMBOL].filter((p) =>
  SIGNERS.includes(recoverDeserializedSignerAddress(p).toLowerCase()),
)
const chosen = authorised.slice(0, 3)
const raw = RedstonePayload.prepare(chosen.map((p) => SignedDataPackage.fromObj(p)), '')
const payload = raw.startsWith('0x') ? raw : `0x${raw}`
// The contract aggregates across signers rather than trusting one, so the
// number to expect is the median of the three - not the first package's value.
const values = chosen.map((p) => p.dataPoints[0].value).sort((a, b) => a - b)
const expected = values[Math.floor(values.length / 2)]

console.log(`${SYMBOL}: gateway median $${expected} of [${values.join(', ')}], payload ${(payload.length - 2) / 2} bytes, ${chosen.length} signers`)

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
