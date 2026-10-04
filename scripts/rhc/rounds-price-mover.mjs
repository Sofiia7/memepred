/** Bounded on-chain demo feed for the current PoolRoundMockPool stand-ins.
 * Read-only by default; --yes-testnet enables pushes. Never rewrites history.
 * RHC_MOVER_PRIVATE_KEY must be a separate funded test wallet, not the keeper.
 * Run beside viem (scripts/node_modules locally, /app/node_modules on the VPS).
 */
import { readFileSync, openSync, writeFileSync, unlinkSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

try {
  const text = readFileSync(new URL('./.env.rounds-mover', import.meta.url), 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch { /* The runtime can supply its environment directly. */ }

const run = process.argv.includes('--yes-testnet')
if (run) {
  const lock = join(tmpdir(), 'rhc-demo-feed.lock')
  try {
    const pid = Number(readFileSync(lock, 'utf8'))
    try { process.kill(pid, 0); throw new Error('A demo feed is already running') } catch (e) { if (e.code !== 'ESRCH') throw e }
    unlinkSync(lock)
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  writeFileSync(openSync(lock, 'wx'), String(process.pid))
  process.on('exit', () => { try { unlinkSync(lock) } catch {} })
}
const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } } })
const pub = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) })
const pools = [
  ['FROGGO', '0xa8B93b1C1E89ad2F1FE127EFD37cc30E28D8F7B4'],
  ['MOONCAT', '0x923a9486cd5cfa7a2929af09ee3082c9b411c37c'],
  ['PEPE', '0x5daf9bbd4a52d90a963e5f4e9a9c7df56673d25c'],
]
const abi = parseAbi([
  'function segments(uint256) view returns (uint32 startTs,int24 tick)',
  'function pushTick(uint32 startTs,int24 tick)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
])
const rounds = '0x1E928aDC9de612b08f78824417d4F5EF354C66D7'
const roundsAbi = parseAbi(['function pools(address) view returns (bool listed,bool wethIsToken0)'])
const every = Number(process.env.RHC_MOVER_EVERY ?? '60')
const maxTx = Number(process.env.RHC_MOVER_MAX_TX ?? '180')
const cap = 64 // The mock's oracle scans its history: never let an unattended feed grow without bounds.
if (!Number.isInteger(every) || every < 30 || !Number.isInteger(maxTx) || maxTx < 1 || maxTx > 180) throw new Error('Interval must be >=30s and push budget 1..180')
if (await pub.getChainId() !== 46630) throw new Error('Refusing any chain except testnet 46630')

async function segment(pool, index) {
  try { return await pub.readContract({ address: pool, abi, functionName: 'segments', args: [BigInt(index)] }) } catch (e) {
    if (e.name === 'ContractFunctionExecutionError' && e.shortMessage?.includes('reverted')) return null
    throw e
  }
}
async function countSegments(pool) {
  if (!await segment(pool, 0)) throw new Error(`${pool}: no stand-in price history`)
  let lo = 1, hi = cap
  if (await segment(pool, hi - 1)) return cap
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (await segment(pool, mid)) lo = mid + 1
    else hi = mid
  }
  return lo
}

const cfg = []
for (const [symbol, pool] of pools) {
  const listed = await pub.readContract({ address: rounds, abi: roundsAbi, functionName: 'pools', args: [pool] })
  if (!listed[0]) throw new Error(`${symbol}: pool is not listed on the current rounds contract`)
  const count = await countSegments(pool)
  const tick = Number((await pub.readContract({ address: pool, abi, functionName: 'slot0' }))[1])
  console.log(`${symbol} ${pool}: ${count} recorded steps, tick ${tick}, budget ${Math.max(0, cap - count)}`)
  cfg.push({ symbol, pool })
}
if (!run) { console.log('Read only. --yes-testnet starts the bounded simulated feed.'); process.exit(0) }
const key = process.env.RHC_MOVER_PRIVATE_KEY
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('RHC_MOVER_PRIVATE_KEY is required (value not shown)')
const account = privateKeyToAccount(key)
const wallet = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) })
if (await pub.getBalance({ address: account.address }) < 100_000_000_000_000n) throw new Error('Demo wallet needs at least 0.0001 test ETH for gas')
console.log(`SIMULATED testnet feed, wallet ${account.address}, every ${every}s, max ${maxTx} pushes, max ${cap} stored steps per pool`)
let sent = 0, failures = 0
while (sent < maxTx) {
  let available = 0
  for (const { symbol, pool } of cfg) {
    if (sent >= maxTx) break
    const count = await countSegments(pool)
    if (count >= cap) continue
    available++
    const tick = Number((await pub.readContract({ address: pool, abi, functionName: 'slot0' }))[1])
    const delta = randomInt(8, 31) * (randomInt(0, 100) < (tick > 200 ? 25 : tick < -200 ? 75 : 50) ? 1 : -1)
    const next = Math.max(-400, Math.min(400, tick + delta))
    const ts = Number((await pub.getBlock()).timestamp)
    const last = await segment(pool, count - 1)
    // Future scheduled prices are left intact; only append at the current chain time.
    if (Number(last[0]) >= ts || next === tick) continue
    try {
      const { request } = await pub.simulateContract({ account, address: pool, abi, functionName: 'pushTick', args: [ts, next] })
      const hash = await wallet.writeContract(request)
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 })
      if (receipt.status !== 'success') throw new Error('Price push reverted')
      sent++; failures = 0
      console.log(`${new Date().toISOString()} ${symbol} ${tick} -> ${next}, step ${count + 1}/${cap}, tx ${hash}, gas ${formatEther(receipt.gasUsed * receipt.effectiveGasPrice)} ETH`)
    } catch (e) {
      console.error(`${symbol}: ${String(e.shortMessage ?? e.message).split('\n')[0].slice(0, 180)}`)
      if (++failures >= 3) throw new Error('Stopping after three failed pushes')
    }
  }
  if (!available || sent >= maxTx) break
  await new Promise((resolve) => setTimeout(resolve, every * 1000))
}
console.log(`Demo feed stopped safely after ${sent} pushes; recorded history remains on chain.`)
