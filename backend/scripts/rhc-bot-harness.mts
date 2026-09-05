/**
 * rhc-bot-harness - synthetic trading traffic against the Robinhood Chain
 * deployment, for the 48h soak.
 *
 * A sibling of bot-harness.ts rather than a rewrite of it: that one keeps
 * driving Base, and the differences here are not cosmetic.
 *
 *   **The price comes from the resolver, on chain.** bot-harness fetches a
 *   price from Pyth Hermes, and Pyth was replaced by RedStone months ago - so
 *   getCurrentPrice returns null, actPlaceBet returns early, and no bet is ever
 *   placed. That is the likeliest reason this protocol has six orders in its
 *   whole history. Here the strike is a staticcall to
 *   PoolOracleResolver.spotPriceWad, so there is no gateway to be broken by.
 *
 *   **Stakes are eighteen-decimal WETH**, and the bounds come from the market
 *   contract rather than from CLI defaults measured in dollars.
 *
 *   **Markets are found per pool.** PoolMarketFactory has no getAllFeedIds -
 *   there is no feed whitelist to enumerate - so the pools to trade are named
 *   explicitly and their markets read from getActiveMarkets.
 *
 * Usage:
 *   cd backend && npx tsx scripts/rhc-bot-harness.mts --bots 3 --duration 48h --tick 600s
 *
 * Env (from .env.rhc):
 *   MARKET_FACTORY, ORACLE_RESOLVER, USDC_ADDRESS (the stake token)
 *   RHC_FIXTURE_POOL          comma-separated pools to trade
 *   PRIVATE_KEY               the faucet: holds the stake token and gas
 *   BOT_MNEMONIC              BIP-39 seed; bots are addresses 0..N-1
 */
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
// The soak runs against a profile of its own, so it loads that file rather
// than the repo-root .env, whose contract addresses point at Base.
config({ path: resolve(fileURLToPath(new URL('.', import.meta.url)), '../..', process.env.RHC_ENV_FILE ?? '.env.rhc') })

import {
  createPublicClient, createWalletClient, http, parseEther, formatEther,
  type Address, type Hex,
} from 'viem'
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts'
import { defineChain } from 'viem'
import { topUpAmount } from '../../scripts/topUpPlan.js'
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

// ── CLI ───────────────────────────────────────────────────────
function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}
function parseDuration(s: string): number {
  const m = s.match(/^(\d+)(s|m|h)$/)
  if (!m) throw new Error(`bad duration ${s}`)
  const n = Number(m[1])
  return m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000
}

const N_BOTS = Number(arg('--bots', '8'))
const TICK_MS = parseDuration(arg('--tick', '20s'))
const RUN_MS = parseDuration(arg('--duration', '48h'))
const LOG_FILE = arg('--log', `logs/rhc-soak-${Date.now()}.jsonl`)

// Gas per bot. At the testnet's 0.02 gwei a bet costs about 7e-6 ETH, so this
// is a few thousand transactions - and the faucet only holds 0.0078 ETH, so it
// has to be small enough that eight bots can be funded from it.
const ETH_FLOOR = parseEther(arg('--eth-floor', '0.0002'))
const ETH_TARGET = parseEther(arg('--eth-target', '0.0005'))

// ── CHAIN ─────────────────────────────────────────────────────
const CHAIN_ID = Number(process.env.CHAIN_ID ?? '46630')
const RPC = process.env.RHC_RPC_URL
  ?? (CHAIN_ID === 4663 ? 'https://rpc.mainnet.chain.robinhood.com' : 'https://rpc.testnet.chain.robinhood.com')
const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 4663 ? 'Robinhood Chain' : 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})

const FACTORY = process.env.MARKET_FACTORY as Address
const RESOLVER = process.env.ORACLE_RESOLVER as Address
const STAKE = process.env.USDC_ADDRESS as Address
const POOLS = (process.env.RHC_FIXTURE_POOL ?? '').split(',').map((s) => s.trim()).filter(Boolean) as Address[]
const FAUCET_KEY = process.env.PRIVATE_KEY as Hex
const BOT_MNEMONIC = process.env.BOT_MNEMONIC
const SLIPPAGE_BPS = 500n

if (!FACTORY || !RESOLVER || !STAKE) throw new Error('MARKET_FACTORY, ORACLE_RESOLVER and USDC_ADDRESS must be set')
if (!POOLS.length) throw new Error('RHC_FIXTURE_POOL must name at least one pool')
if (!BOT_MNEMONIC) throw new Error('BOT_MNEMONIC must be set')
if (!FAUCET_KEY) throw new Error('PRIVATE_KEY must be set (the faucet)')

// ── ABIs ──────────────────────────────────────────────────────
const FACTORY_ABI = [
  { name: 'getActiveMarkets', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address[]' }] },
  { name: 'feedIdFor', type: 'function', stateMutability: 'pure', inputs: [{ type: 'address' }], outputs: [{ type: 'bytes32' }] },
] as const

const RESOLVER_ABI = [
  { name: 'spotPriceWad', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
] as const

const MARKET_ABI = [
  { name: 'placeBet', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ type: 'uint8' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
    outputs: [{ type: 'uint256' }] },
  { name: 'claim', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { name: 'refundExpired', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { name: 'feedId', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'MIN_BET', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'MAX_BET', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'nextOrderId', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'getPendingDepth', type: 'function', stateMutability: 'view', inputs: [],
    outputs: [{ name: 'up', type: 'uint256' }, { name: 'down', type: 'uint256' }] },
  { name: 'getOrder', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [
    { name: 'trader', type: 'address' }, { name: 'direction', type: 'uint8' }, { name: 'amount', type: 'uint256' },
    { name: 'filledAmount', type: 'uint256' }, { name: 'referrer', type: 'address' }, { name: 'status', type: 'uint8' },
    { name: 'placedAt', type: 'uint256' }, { name: 'matchId', type: 'uint256' }, { name: 'pendingSettlements', type: 'uint256' },
    { name: 'payout', type: 'uint256' }, { name: 'unmatchedRefunded', type: 'bool' } ] },
] as const

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

// ── CLIENTS ───────────────────────────────────────────────────
const pub = createPublicClient({ chain, transport: http(RPC) })
const faucet = privateKeyToAccount(FAUCET_KEY)
const faucetClient = createWalletClient({ account: faucet, chain, transport: http(RPC) })

interface Bot {
  index: number
  address: Address
  client: ReturnType<typeof createWalletClient>
}
const mkBot = (i: number): Bot => {
  const account = mnemonicToAccount(BOT_MNEMONIC!, { addressIndex: i })
  // The account is bound to the client, which is what makes viem sign locally.
  // Passing `account: bot.address` at a call site instead - an address rather
  // than an Account - makes it a JSON-RPC account, and viem then calls
  // eth_sendTransaction, which no public RPC implements. bot-harness.ts does
  // exactly that on every write, which is a second reason it has never placed
  // a bet.
  return { index: i, address: account.address, client: createWalletClient({ account, chain, transport: http(RPC) }) }
}

// ── METRICS ───────────────────────────────────────────────────
const metrics = {
  startTs: Date.now(),
  placeBetOk: 0, placeBetFail: 0,
  claimOk: 0, claimFail: 0,
  refundOk: 0, refundFail: 0,
  stakedWei: 0n, paidOutWei: 0n,
}

if (!existsSync(dirname(LOG_FILE))) mkdirSync(dirname(LOG_FILE), { recursive: true })
writeFileSync(LOG_FILE, '')
const log = (event: string, data: Record<string, unknown> = {}) =>
  appendFileSync(LOG_FILE, JSON.stringify({ ts: Date.now(), event, ...data }) + '\n')

// ── FUNDING ───────────────────────────────────────────────────
async function fundIfNeeded(bot: Bot, stakeFloor: bigint, stakeTarget: bigint) {
  const [gas, stake] = await Promise.all([
    pub.getBalance({ address: bot.address }),
    pub.readContract({ address: STAKE, abi: ERC20_ABI, functionName: 'balanceOf', args: [bot.address] }),
  ])

  const gasTopUp = topUpAmount(gas, ETH_FLOOR, ETH_TARGET)
  if (gasTopUp > 0n) {
    const hash = await faucetClient.sendTransaction({ to: bot.address, value: gasTopUp })
    await pub.waitForTransactionReceipt({ hash })
    log('fund_gas', { bot: bot.index, wei: gasTopUp.toString() })
  }

  const stakeTopUp = topUpAmount(stake, stakeFloor, stakeTarget)
  if (stakeTopUp > 0n) {
    const hash = await faucetClient.writeContract({
      address: STAKE, abi: ERC20_ABI, functionName: 'transfer', args: [bot.address, stakeTopUp],
    })
    await pub.waitForTransactionReceipt({ hash })
    log('fund_stake', { bot: bot.index, wei: stakeTopUp.toString() })
  }
}

// ── MARKETS ───────────────────────────────────────────────────
let marketCache: Address[] = []
let marketCacheAt = 0

async function markets(): Promise<Address[]> {
  // Refreshed rather than read once: poolWatcher creates markets while this
  // runs, and a harness that cached at startup would never trade them.
  if (Date.now() - marketCacheAt < 60_000 && marketCache.length) return marketCache
  const found: Address[] = []
  for (const pool of POOLS) {
    const feedId = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'feedIdFor', args: [pool] })
    const ms = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'getActiveMarkets', args: [feedId] })
    found.push(...ms)
  }
  marketCache = found
  marketCacheAt = Date.now()
  return found
}

// ── ACTIONS ───────────────────────────────────────────────────
async function actPlaceBet(bot: Bot) {
  const ms = await markets()
  if (!ms.length) return
  const market = ms[Math.floor(Math.random() * ms.length)]!

  const feedId = await pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'feedId' })
  // The strike, from the same call the market itself will make. No gateway.
  let price: bigint
  try {
    price = await pub.readContract({ address: RESOLVER, abi: RESOLVER_ABI, functionName: 'spotPriceWad', args: [feedId] })
  } catch (err) {
    log('price_unavailable', { market, err: String(err).slice(0, 120) })
    return
  }
  if (price === 0n) return

  const [minBet, maxBet] = await Promise.all([
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'MIN_BET' }),
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'MAX_BET' }),
  ])
  // Uniform over the allowed range, in units of MIN_BET, so partial fills
  // happen naturally: two bots rarely pick the same size.
  const steps = Number(maxBet / minBet)
  const amount = minBet * BigInt(1 + Math.floor(Math.random() * Math.max(1, steps)))

  /**
   * Take the thinner side of the book, not a coin flip.
   *
   * A fair coin over three bots produced 1 UP against 6 DOWN in the first
   * hour - unlikely but perfectly possible - and an unmatched order is a
   * refund, not a settlement. The soak is meant to exercise matching, payouts
   * and claims, and a flow that never crosses exercises none of them.
   *
   * Standing opposite the queue is also closer to what a real counterparty
   * does, so it is not only a way to force the interesting path. The coin flip
   * survives as the tie-break, which is what keeps refunds and unmatched
   * expiry in the mix.
   */
  let dir: number
  try {
    const [upDepth, downDepth] = await pub.readContract({
      address: market, abi: MARKET_ABI, functionName: 'getPendingDepth',
    })
    dir = upDepth === downDepth ? (Math.random() < 0.5 ? 0 : 1) : upDepth > downDepth ? 1 : 0
  } catch {
    dir = Math.random() < 0.5 ? 0 : 1
  }

  const allowance = await pub.readContract({
    address: STAKE, abi: ERC20_ABI, functionName: 'allowance', args: [bot.address, market],
  })
  if (allowance < amount) {
    const hash = await bot.client.writeContract({
      address: STAKE, abi: ERC20_ABI, functionName: 'approve', args: [market, 2n ** 255n],
    })
    await pub.waitForTransactionReceipt({ hash })
  }

  try {
    const hash = await bot.client.writeContract({
      address: market, abi: MARKET_ABI, functionName: 'placeBet',
      args: [dir, amount, '0x0000000000000000000000000000000000000000', price, SLIPPAGE_BPS],
    })
    const r = await pub.waitForTransactionReceipt({ hash })
    if (r.status !== 'success') throw new Error('reverted')
    metrics.placeBetOk++
    metrics.stakedWei += amount
    log('bet', { bot: bot.index, market, dir, wei: amount.toString(), gas: r.gasUsed.toString() })
  } catch (err) {
    metrics.placeBetFail++
    log('bet_fail', { bot: bot.index, market, err: String(err).slice(0, 200) })
  }
}

/** Sweep this bot's orders on one market, claiming or refunding what it can. */
async function actSweep(bot: Bot) {
  const ms = await markets()
  if (!ms.length) return
  const market = ms[Math.floor(Math.random() * ms.length)]!

  const next = await pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'nextOrderId' })
  const now = BigInt(Math.floor(Date.now() / 1000))

  // Newest first, bounded: an order this bot placed recently is the one most
  // likely to be claimable, and walking every order on a busy market each tick
  // would spend the whole tick on reads.
  const from = next > 25n ? next - 25n : 1n
  for (let id = next - 1n; id >= from; id--) {
    let o
    try {
      o = await pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'getOrder', args: [id] })
    } catch { continue }
    if (o[0].toLowerCase() !== bot.address.toLowerCase()) continue

    const status = Number(o[5])
    const payout = o[9]
    // 2 = SETTLED in OrderbookMarket's OrderStatus.
    if (status === 2 && payout > 0n) {
      try {
        const hash = await bot.client.writeContract({
          address: market, abi: MARKET_ABI, functionName: 'claim', args: [id],
        })
        await pub.waitForTransactionReceipt({ hash })
        metrics.claimOk++
        metrics.paidOutWei += payout
        log('claim', { bot: bot.index, market, order: id.toString(), wei: payout.toString() })
      } catch (err) {
        metrics.claimFail++
        log('claim_fail', { bot: bot.index, market, order: id.toString(), err: String(err).slice(0, 160) })
      }
      return
    }

    // 0 = PENDING, and MATCH_TIMEOUT is five minutes.
    if (status === 0 && now - o[6] > 310n) {
      try {
        const hash = await bot.client.writeContract({
          address: market, abi: MARKET_ABI, functionName: 'refundExpired', args: [id],
        })
        await pub.waitForTransactionReceipt({ hash })
        metrics.refundOk++
        log('refund', { bot: bot.index, market, order: id.toString() })
      } catch (err) {
        metrics.refundFail++
        log('refund_fail', { bot: bot.index, market, order: id.toString(), err: String(err).slice(0, 160) })
      }
      return
    }
  }
}

// ── MAIN ──────────────────────────────────────────────────────
const bots = Array.from({ length: N_BOTS }, (_, i) => mkBot(i))

console.log(`rhc-bot-harness  chain ${chain.id}  ${N_BOTS} bots  tick ${TICK_MS / 1000}s  for ${RUN_MS / 3_600_000}h`)
console.log(`factory ${FACTORY}`)
console.log(`log     ${LOG_FILE}`)

const ms0 = await markets()
console.log(`markets ${ms0.length}: ${ms0.join(', ') || '(none yet - poolWatcher should create them)'}`)
if (!ms0.length) console.log('waiting for markets; the harness will pick them up as they appear')

// Bounds come from a live market, so funding follows the contract rather than
// a CLI default measured in dollars.
let stakeFloor = parseEther('0.05')
let stakeTarget = parseEther('0.2')
if (ms0.length) {
  const maxBet = await pub.readContract({ address: ms0[0]!, abi: MARKET_ABI, functionName: 'MAX_BET' })
  stakeFloor = maxBet * 3n
  stakeTarget = maxBet * 10n
}

console.log(`\nfunding ${N_BOTS} bots (gas floor ${formatEther(ETH_FLOOR)}, stake floor ${formatEther(stakeFloor)})`)
for (const b of bots) {
  await fundIfNeeded(b, stakeFloor, stakeTarget)
  process.stdout.write(`\r  funded ${b.index + 1}/${N_BOTS}`)
}
console.log('\n')

log('start', { bots: N_BOTS, tickMs: TICK_MS, runMs: RUN_MS, chain: chain.id, markets: ms0.length })

const deadline = Date.now() + RUN_MS
let ticks = 0

while (Date.now() < deadline) {
  ticks++
  await Promise.all(
    bots.map(async (b) => {
      try {
        // 70% bet, 30% sweep. The sweep is what turns settled positions back
        // into balance, so a harness that only bets drains itself and stops.
        if (Math.random() < 0.7) await actPlaceBet(b)
        else await actSweep(b)
      } catch (err) {
        log('tick_error', { bot: b.index, err: String(err).slice(0, 200) })
      }
    }),
  )

  if (ticks % 10 === 0) {
    const hours = ((Date.now() - metrics.startTs) / 3_600_000).toFixed(2)
    const line =
      `[${hours}h] bets ${metrics.placeBetOk}/${metrics.placeBetOk + metrics.placeBetFail}  ` +
      `claims ${metrics.claimOk}  refunds ${metrics.refundOk}  ` +
      `staked ${formatEther(metrics.stakedWei)}  paid ${formatEther(metrics.paidOutWei)}`
    console.log(line)
    log('metrics', {
      ...metrics,
      stakedWei: metrics.stakedWei.toString(),
      paidOutWei: metrics.paidOutWei.toString(),
    })
    // Top up whoever ran dry, so the soak does not quietly become idle.
    for (const b of bots) await fundIfNeeded(b, stakeFloor, stakeTarget).catch(() => {})
  }

  await new Promise((r) => setTimeout(r, TICK_MS))
}

console.log('\nsoak complete')
log('end', { ...metrics, stakedWei: metrics.stakedWei.toString(), paidOutWei: metrics.paidOutWei.toString() })
