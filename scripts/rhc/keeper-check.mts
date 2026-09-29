/**
 * Does the deployed KEEPER settle and refund by itself? Places a few bets on the fast (60 s)
 * vault-enabled market and NEVER calls the resolver: the only thing that can settle them is
 * the keeper running on the server. Measures how long after `settleAt` each match reached a
 * final state.
 *
 *   scripts/node_modules/.bin/tsx scripts/rhc/keeper-check.mts
 *
 * Signs real transactions on chain 46630 with the wallet in the repo-root .env (PRIVATE_KEY).
 * Env: RHC_RESOLVER, RHC_WETH, RHC_MARKET_LP60, RHC_POOL_LP60 as in e2e-verify.mts, plus
 *   ROUNDS  bets to place, default 4; every third one trips the consistency guard so the
 *           keeper has to REFUND it (the resolver refunds on the first call after settleAt).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  createPublicClient, createWalletClient, http, parseAbi, parseEventLogs, formatEther, parseEther,
  defineChain, type Address, type Hex,
} from 'viem'
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

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v }
const RPC = process.env.RHC_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com'
const chain = defineChain({
  id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})
const pub = createPublicClient({ chain, transport: http(RPC) })
const RESOLVER = need('RHC_RESOLVER') as Address
const WETH = need('RHC_WETH') as Address
const MARKET = need('RHC_MARKET_LP60') as Address
const POOL = need('RHC_POOL_LP60') as Address
const ROUNDS = Number(process.env.ROUNDS ?? '4')
const rawKey = need('PRIVATE_KEY')
const account = privateKeyToAccount((rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex)
const wallet = createWalletClient({ account, chain, transport: http(RPC) })

const ABI = parseAbi([
  'function placeBet(uint8 dir,uint256 amount,address referrer,uint256 expectedPrice,uint256 slippageBps) returns (uint256)',
  'function feedId() view returns (bytes32)',
  'function getMatch(uint256) view returns ((uint256 upOrderId,uint256 downOrderId,uint256 amount,uint256 entryPrice,uint256 settleAt,uint256 exitPrice,bool settled,bool upWon,bool lpMatch))',
  'function getOrder(uint256) view returns ((address trader,uint8 direction,uint256 amount,uint256 filledAmount,address referrer,uint8 status,uint256 placedAt,uint256 matchId,uint256 pendingSettlements,uint256 payout,bool unmatchedRefunded,uint256 expectedPrice,uint256 slippageBps))',
  'event OrderPlaced(uint256 indexed orderId,address indexed trader,uint8 dir,uint256 amount)',
])
const RES = parseAbi(['function spotPriceWad(bytes32) view returns (uint256)'])
const POOLABI = parseAbi([
  'function pushTick(uint32 startTs,int24 tick)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function token0() view returns (address)',
])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = async () => Number((await pub.getBlock()).timestamp)

async function send(address: Address, abi: any, functionName: string, args: any[]) {
  const { request } = await pub.simulateContract({ account, address, abi, functionName, args } as any)
  const hash = await wallet.writeContract(request as any)
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`)
  return { hash, receipt }
}

async function main() {
  const t0 = (await pub.readContract({ address: POOL, abi: POOLABI, functionName: 'token0' })) as Address
  const sign = t0.toLowerCase() === WETH.toLowerCase() ? -1 : 1 // WETH as token0 inverts the price
  await send(WETH, parseAbi(['function mint(address,uint256)']), 'mint', [account.address, parseEther('0.1')])
  await send(WETH, parseAbi(['function approve(address,uint256) returns (bool)']), 'approve', [MARKET, 2n ** 255n])
  const feed = (await pub.readContract({ address: MARKET, abi: ABI, functionName: 'feedId' })) as Hex
  const lags: number[] = []
  let refunds = 0
  console.log(`keeper check: ${ROUNDS} round(s) on ${MARKET}, wallet ${account.address}`)

  for (let round = 1; round <= ROUNDS; round++) {
    const trip = round % 3 === 0
    const price = (await pub.readContract({ address: RESOLVER, abi: RES, functionName: 'spotPriceWad', args: [feed] })) as bigint
    const { receipt } = await send(MARKET, ABI, 'placeBet', [0, parseEther('0.005'), '0x0000000000000000000000000000000000000000', price, 100n])
    const orderId = parseEventLogs({ abi: ABI, logs: receipt.logs, eventName: 'OrderPlaced' })[0].args.orderId as bigint
    const order = (await pub.readContract({ address: MARKET, abi: ABI, functionName: 'getOrder', args: [orderId] })) as any
    const matchId = order.matchId as bigint
    const m0 = (await pub.readContract({ address: MARKET, abi: ABI, functionName: 'getMatch', args: [matchId] })) as any
    const settleAt = Number(m0.settleAt)
    const tick = Number((await pub.readContract({ address: POOL, abi: POOLABI, functionName: 'slot0' }))[1])
    // normal round: a small step up right after the entry; guard round: a 4% jump inside the last 10 s
    const pushAt = trip ? settleAt - 10 : Number((await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp) + 5
    const to = tick + sign * (trip ? 400 : 60)
    await send(POOL, POOLABI, 'pushTick', [pushAt, to])
    console.log(`round ${round}${trip ? ' (guard trip)' : ''}: order ${orderId}, match ${matchId}, lpMatch=${m0.lpMatch}, settleAt in ${settleAt - (await now())}s; waiting for the keeper...`)

    // Only watch, never call the resolver.
    let finalAt = 0
    let m: any = m0
    for (let i = 0; i < 90; i++) {
      await sleep(3000)
      m = (await pub.readContract({ address: MARKET, abi: ABI, functionName: 'getMatch', args: [matchId] })) as any
      if (m.settled) { finalAt = await now(); break }
    }
    if (!finalAt) { console.log(`round ${round}: NOT resolved within 270 s of watching`); continue }
    const lag = finalAt - settleAt
    lags.push(lag)
    const refunded = m.exitPrice === 0n
    if (refunded) refunds++
    console.log(`round ${round}: ${refunded ? 'REFUNDED' : `settled upWon=${m.upWon}`} about ${lag}s after settleAt`)
    // The entry check refuses a bet while the pool's spot is more than 2% away from its own
    // 60 s average, and a guard-trip round leaves it 4% away: let that average catch up first.
    if (trip && round < ROUNDS) { console.log('  letting the 60 s entry average catch up with the jump...'); await sleep(75_000) }
  }
  lags.sort((a, b) => a - b)
  const pct = (p: number) => lags.length ? lags[Math.min(lags.length - 1, Math.floor(p * lags.length))] : NaN
  console.log(`\nresolved ${lags.length}/${ROUNDS} by the keeper alone (${refunds} refund(s)); lag after settleAt: min ${lags[0]}s, median ${pct(0.5)}s, max ${lags[lags.length - 1]}s`)
  console.log(`ETH left ${formatEther(await pub.getBalance({ address: account.address }))}`)
  process.exit(lags.length === ROUNDS ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(2) })
