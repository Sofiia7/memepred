/** Testnet-only deployment/activation of immutable demo oracles. No PoolRounds redeploy.
 * tsx ...                 read-only balances and plan
 * tsx ... --deploy        deploy and register three pools at fee tier 3000
 * tsx ... --activate      list them, then retire only new betting on the old pools
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, formatEther, http, keccak256, parseAbi, parseEther, stringToHex, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { artifact, asKey, readEnvNames, readSoakKeys, TESTNET_RPC } from './rounds-lib.mts'

const chain = defineChain({ id: 46630, name: 'RHC Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [TESTNET_RPC] } } })
const pub = createPublicClient({ chain, transport: http() })
if (await pub.getChainId() !== 46630) throw new Error('Refusing another chain')
const rounds = '0x1e928adc9de612b08f78824417d4f5ef354c66d7' as Address
const rAbi = parseAbi(['function owner() view returns (address)', 'function v3Factory() view returns (address)', 'function listPool(address)', 'function delistPool(address)', 'function pools(address) view returns (bool,bool)'])
const poolAbi = parseAbi(['function token0() view returns (address)', 'function token1() view returns (address)', 'function fee() view returns (uint24)'])
const factoryAbi = parseAbi(['function register(address,address,uint24,address)', 'function getPool(address,address,uint24) view returns (address)'])
const old = [
  ['FROGGO', '0xa8b93b1c1e89ad2f1fe127efd37cc30e28d8f7b4'],
  ['MOONCAT', '0x923a9486cd5cfa7a2929af09ee3082c9b411c37c'],
  ['PEPE', '0x5daf9bbd4a52d90a963e5f4e9a9c7df56673d25c'],
] as const
const env = readEnvNames(['PRIVATE_KEY'])
const owner = privateKeyToAccount(asKey(env.PRIVATE_KEY, 'deployer'))
const demo = privateKeyToAccount(readSoakKeys()[2])
const ownerWallet = createWalletClient({ account: owner, chain, transport: http() })
const demoWallet = createWalletClient({ account: demo, chain, transport: http() })
if ((await pub.readContract({ address: rounds, abi: rAbi, functionName: 'owner' })).toLowerCase() !== owner.address.toLowerCase()) throw new Error('Wrong owner')
const factory = await pub.readContract({ address: rounds, abi: rAbi, functionName: 'v3Factory' })
const path = new URL('./.continuous-demo-deploy.json', import.meta.url)
const state: any = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { chainId: 46630, rounds, factory, pools: [], transactions: [] }
if (state.rounds !== rounds || state.factory.toLowerCase() !== factory.toLowerCase()) throw new Error('Saved deployment is for another contract')
const save = () => writeFileSync(path, JSON.stringify(state, null, 2) + '\n')
console.log(`Same PoolRounds ${rounds}, factory ${factory}; owner ${owner.address} ${formatEther(await pub.getBalance({ address: owner.address }))} ETH; demo deployer ${demo.address} ${formatEther(await pub.getBalance({ address: demo.address }))} ETH`)
const deploy = process.argv.includes('--deploy'), activate = process.argv.includes('--activate')
if (!deploy && !activate) { console.log('Read only: deploy constant-storage demo pools at fee 3000, list on existing rounds, retire new bets on old fee-10000 pools.'); process.exit(0) }
const a = artifact('ContinuousDemoPool.sol/ContinuousDemoPool.json')
async function mined(hash: `0x${string}`, label: string) {
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`)
  state.transactions.push({ label, hash, block: String(receipt.blockNumber), gas: String(receipt.gasUsed) }); save()
  console.log(`${label}: ${hash}, gas ${receipt.gasUsed}`)
  return receipt
}

if (deploy) {
  for (const [symbol, oldPool] of old) {
    let p = state.pools.find((p: any) => p.symbol === symbol)
    if (!p) {
      const t0 = await pub.readContract({ address: oldPool, abi: poolAbi, functionName: 'token0' })
      const t1 = await pub.readContract({ address: oldPool, abi: poolAbi, functionName: 'token1' })
      const [token0, token1] = BigInt(t0) < BigInt(t1) ? [t0, t1] : [t1, t0]
      const seed = keccak256(stringToHex(`FlipTheMeme continuous testnet demo: ${symbol}`))
      const args = [token0, token1, seed]
      const hash = await demoWallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args })
      const receipt = await mined(hash, `deploy ${symbol}`)
      p = { symbol, oldPool, pool: receipt.contractAddress, token0, token1, seed, deployTx: hash,
        constructorArgs: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }], [token0, token1, seed]) }
      state.pools.push(p); save()
    }
    const current = await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'getPool', args: [p.token0, p.token1, 3000] })
    if (current.toLowerCase() !== p.pool.toLowerCase()) {
      // Never overwrite an unrelated registered pool, even on the demo factory.
      if (current !== '0x0000000000000000000000000000000000000000') throw new Error('Fee 3000 is already registered; leaving it untouched')
      await mined(await demoWallet.writeContract({ address: factory, abi: factoryAbi, functionName: 'register', args: [p.token0, p.token1, 3000, p.pool] }), `register ${symbol}`)
    }
    console.log(`${symbol}: ${p.pool}`)
  }
}
if (activate) {
  if (state.pools.length !== 3) throw new Error('Deploy all three first')
  if (await pub.getBalance({ address: owner.address }) < parseEther('0.00003')) {
    await mined(await demoWallet.sendTransaction({ to: owner.address, value: parseEther('0.00005') }), 'owner test-gas top-up')
  }
  for (const p of state.pools) {
    const listed = await pub.readContract({ address: rounds, abi: rAbi, functionName: 'pools', args: [p.pool] })
    if (!listed[0]) {
      const { request } = await pub.simulateContract({ account: owner, address: rounds, abi: rAbi, functionName: 'listPool', args: [p.pool] })
      await mined(await ownerWallet.writeContract(request), `list ${p.symbol}`)
    }
  }
  // delistPool leaves fixStrike, settlement and all payouts on previous tickets available.
  for (const p of state.pools) {
    const listed = await pub.readContract({ address: rounds, abi: rAbi, functionName: 'pools', args: [p.oldPool] })
    if (listed[0]) await mined(await ownerWallet.writeContract({ address: rounds, abi: rAbi, functionName: 'delistPool', args: [p.oldPool] }), `retire new betting ${p.symbol}`)
  }
  state.activatedAt = new Date().toISOString(); save()
}
console.log(JSON.stringify(state.pools, null, 2))
