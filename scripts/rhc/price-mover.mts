/**
 * Keeps the stand-in pools' prices moving so a demo has both outcomes to show.
 *
 *   scripts/node_modules/.bin/tsx scripts/rhc/price-mover.mts
 *
 * THE TESTNET HAS NO REAL UNISWAP: the pools behind the demo markets are stand-ins
 * (test/mocks/MockUniswapV3Pool.sol) whose price is whatever their owner records.
 * This script is that owner, doing a mean-reverting random walk. It exists for demos
 * and soak runs on chain 46630 only and refuses to run anywhere else.
 *
 * Env (a repo-root .env supplies PRIVATE_KEY, the funded testnet wallet):
 *   RHC_MOVER_POOLS   comma separated pool addresses to move (required)
 *   RHC_MOVER_EVERY   seconds between pushes per pool, default 30
 *   RHC_MOVER_STEP    largest single step in ticks, default 40 (about 0.4%)
 *   RHC_MOVER_LIMIT   the walk is pulled back towards tick 0 beyond this, default 500
 *   RHC_MOVER_MAX_TX  stop after this many pushes in total, default unlimited
 *
 * Each push costs a few thousand gwei of testnet gas; the default cadence over
 * three pools is roughly 0.002 ETH a day at 0.01 gwei.
 *
 * The step is kept well inside the 2% entry guard (a bet is refused while the pool's
 * spot has run more than 2% away from its own 60 s average) so traders can still enter.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createPublicClient, createWalletClient, http, parseAbi, defineChain, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const here = dirname(fileURLToPath(import.meta.url))
function loadEnvFile(file: string) {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m || process.env[m[1]]) continue // an empty variable in the shell must not shadow the file
    process.env[m[1]] = m[2].split(' #')[0].trim().replace(/^"|"$/g, '')
  }
}
loadEnvFile(resolve(here, '../../.env'))

const RPC = process.env.RHC_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com'
const chain = defineChain({
  id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})
const pub = createPublicClient({ chain, transport: http(RPC) })

const pools = (process.env.RHC_MOVER_POOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean) as Address[]
if (pools.length === 0) throw new Error('RHC_MOVER_POOLS is required (comma separated pool addresses)')
const every = Number(process.env.RHC_MOVER_EVERY ?? '30') * 1000
const step = Number(process.env.RHC_MOVER_STEP ?? '40')
const limit = Number(process.env.RHC_MOVER_LIMIT ?? '500')
const maxTx = process.env.RHC_MOVER_MAX_TX ? Number(process.env.RHC_MOVER_MAX_TX) : Infinity

const rawKey = process.env.PRIVATE_KEY
if (!rawKey) throw new Error('PRIVATE_KEY is required')
const account = privateKeyToAccount((rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex)
const wallet = createWalletClient({ account, chain, transport: http(RPC) })

const POOL = parseAbi([
  'function pushTick(uint32 startTs,int24 tick)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if ((await pub.getChainId()) !== 46630) throw new Error('this script only runs on Robinhood Chain testnet (46630)')
  console.log(`price mover: ${pools.length} pool(s), every ${every / 1000}s, step up to ${step} ticks, wallet ${account.address}`)
  let sent = 0
  for (;;) {
    for (const pool of pools) {
      if (sent >= maxTx) { console.log('max pushes reached, stopping'); return }
      const tick = Number((await pub.readContract({ address: pool, abi: POOL, functionName: 'slot0' }))[1])
      // Mean reversion: the further from 0, the more likely the step points back.
      const pull = Math.max(-1, Math.min(1, tick / limit))
      const drift = -pull * 0.6
      const r = Math.random() * 2 - 1 + drift
      const delta = Math.round(Math.max(-1, Math.min(1, r)) * step)
      const next = Math.max(-limit * 2, Math.min(limit * 2, tick + (delta === 0 ? 1 : delta)))
      const ts = Number((await pub.getBlock()).timestamp) + 1
      try {
        const hash = await wallet.writeContract({ address: pool, abi: POOL, functionName: 'pushTick', args: [ts, next] })
        await pub.waitForTransactionReceipt({ hash })
        sent++
        console.log(`${new Date().toISOString()} ${pool.slice(0, 10)}... tick ${tick} -> ${next} (${delta >= 0 ? '+' : ''}${delta}) ${hash}`)
      } catch (e) {
        console.log(`push failed for ${pool}: ${String(e).split('\n')[0].slice(0, 160)}`)
      }
    }
    await sleep(every)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
