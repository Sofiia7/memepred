/**
 * Send the testnet ETH of the throwaway wallets back to one address, when the faucet is dry and the
 * ETH is needed elsewhere (a browser-wallet check, for example).
 *
 *   scripts\node_modules\.bin\tsx scripts\rhc\wallets-return.mts --to 0x...                  read only: what would be sent
 *   scripts\node_modules\.bin\tsx scripts\rhc\wallets-return.mts --to 0x... --yes-testnet    send it
 *
 * Wallets: scripts/rhc/.soak-wallets.json (the players of rounds-e2e.mts --testnet), or --file PATH for another
 * key file of the same shape; --amounts 0.01,0.005 sends exactly that much from the first, second... wallet (an
 * empty entry or no entry means everything); --keep ETH leaves that much on every wallet (default 0). When a
 * wallet's ETH is short of what it sends, its WETH (--weth, default the TestWETH of the 2 October deployment,
 * withdrawable one for one) is unwrapped first. The transfer's own fee is estimated by the node. Keys are never
 * printed. Testnet only.
 */
import { createPublicClient, createWalletClient, defineChain, formatEther, http, isAddress, parseAbi, parseEther, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readSoakKeys, SOAK_WALLETS, TESTNET_ID, TESTNET_RPC } from './rounds-lib.mts'

const argv = process.argv.slice(2)
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
const YES = argv.includes('--yes-testnet')
const to = opt('--to')
if (!to || !isAddress(to)) throw new Error('--to 0x... (the address that receives the ETH) is required')
const keep = parseEther(opt('--keep') ?? '0')
const file = opt('--file') ?? SOAK_WALLETS
const amounts = (opt('--amounts') ?? '').split(',').map((x) => (x.trim() ? parseEther(x.trim()) : null))
const weth = (opt('--weth') ?? '0x702431c8ef4e21fc4180c8395a4b0f3464b7d5a3') as Address
const WETH_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function withdraw(uint256)'])

const rpcUrl = process.env.RHC_RPC_URL ?? TESTNET_RPC
if (/mainnet/i.test(rpcUrl)) throw new Error(`refusing an RPC that names mainnet: ${rpcUrl}`)
const chain = defineChain({ id: TESTNET_ID, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } })
const pub = createPublicClient({ chain, transport: http(rpcUrl) })
const id = await pub.getChainId()
if (id !== TESTNET_ID) throw new Error(`chain ${id} is not the testnet ${TESTNET_ID}: refusing`)

const keys = readSoakKeys(file)
if (!keys.length) throw new Error(`no keys in ${file}`)
const fees = await pub.estimateFeesPerGas()
const maxFee = fees.maxFeePerGas ?? (await pub.getGasPrice())
console.log(`chain ${id}, ${keys.length} wallets from ${file}, to ${to}${keep > 0n ? `, keeping ${formatEther(keep)} ETH on each` : ''}`)
let total = 0n
const plan: Array<{ name: string; account: ReturnType<typeof privateKeyToAccount>; value: bigint; gas: bigint; unwrap: bigint }> = []
for (const [i, k] of keys.entries()) {
  const account = privateKeyToAccount(k)
  const name = `wallet #${i + 1}`
  const balance = await pub.getBalance({ address: account.address })
  const wethBal = await pub.readContract({ address: weth, abi: WETH_ABI, functionName: 'balanceOf', args: [account.address] })
  // the transfer's own fee, as the node estimates it (on this chain that includes the L1 part), with a margin of 2x
  let gas = 21_000n
  try { gas = await pub.estimateGas({ account, to: to as Address, value: 1n }) } catch { /* an empty wallet cannot estimate; it sends nothing anyway */ }
  const fee = gas * maxFee * 2n
  const want = amounts[i] ?? null // null: everything
  // unwrap what is missing (plus the fee of the unwrap itself), never more than the wallet holds in WETH
  const unwrapFee = 60_000n * maxFee * 2n
  let unwrap = 0n
  if (want !== null) { const short = want + keep + fee + unwrapFee - balance; if (short > 0n) unwrap = short < wethBal ? short : wethBal }
  else if (wethBal > 0n) unwrap = wethBal
  const available = balance + unwrap - keep - fee - (unwrap > 0n ? unwrapFee : 0n)
  const value = want === null ? available : want
  if (value <= 0n || value > available) { console.log(`  ${name} ${account.address}: ${formatEther(balance)} ETH + ${formatEther(wethBal)} WETH, ${want === null ? 'nothing to send' : `cannot send ${formatEther(want)} (at most ${formatEther(available > 0n ? available : 0n)})`}`); continue }
  console.log(`  ${name} ${account.address}: ${formatEther(balance)} ETH + ${formatEther(wethBal)} WETH -> ${unwrap > 0n ? `unwrap ${formatEther(unwrap)}, ` : ''}send ${formatEther(value)} (fee reserve ${formatEther(fee)})`)
  plan.push({ name, account, value, gas, unwrap })
  total += value
}
console.log(`total ${formatEther(total)} ETH`)
if (!plan.length) process.exit(0)
if (!YES) { console.log('read only. To send: add --yes-testnet'); process.exit(0) }
for (const p of plan) {
  const wallet = createWalletClient({ account: p.account, chain, transport: http(rpcUrl) })
  if (p.unwrap > 0n) {
    const h = await wallet.writeContract({ address: weth, abi: WETH_ABI, functionName: 'withdraw', args: [p.unwrap], chain, account: p.account } as any)
    const r = await pub.waitForTransactionReceipt({ hash: h, timeout: 180_000 })
    if (r.status !== 'success') throw new Error(`${p.name}: withdraw reverted, tx ${h}`)
    console.log(`  ${p.name}: unwrapped ${formatEther(p.unwrap)} WETH, tx ${h}`)
  }
  const hash = await wallet.sendTransaction({ to: to as Address, value: p.value, gas: p.gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n })
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  console.log(`  ${p.name}: ${rc.status}, ${formatEther(p.value)} ETH, tx ${hash}`)
}
console.log(`${to}: ${formatEther(await pub.getBalance({ address: to as Address }))} ETH now`)
