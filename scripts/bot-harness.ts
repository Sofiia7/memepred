/**
 * bot-harness — Sprint 5.2 / 5.3
 *
 * Generates synthetic trading traffic against a Sepolia OrderbookMarket
 * deployment. Designed for the 48h soak: ~50 concurrent traders, mixed
 * UP/DOWN, partial fills, claims, and the occasional refund-expired.
 *
 * What it does each tick (per bot):
 *   1. Pick a random market from `MARKET_FACTORY.getAllFeedIds()` × durations
 *   2. With p≈0.7, placeBet (uniform random amount within [MIN_BET, MAX_BET])
 *   3. With p≈0.2, sweep settled orders → claim
 *   4. With p≈0.1, refundExpired on any PENDING order > 5min old
 *
 * Pre-reqs:
 *   - .env.botharness with USDC_FAUCET_KEY (faucet wallet that holds testnet USDC)
 *   - N keys derived from BOT_MNEMONIC at addresses 0..N-1
 *   - Each bot pre-funded with 100 USDC + 0.01 ETH (script does first-time top-up)
 *
 * Usage:
 *   tsx scripts/bot-harness.ts --bots 50 --duration 48h --tick 30s
 *
 * Tracks USDC conservation invariant: sum(deposits) == sum(payouts) + sum(refunds) + onchain_balance.
 * Logs to JSONL for post-soak analysis.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  parseEther,
  type Address,
  type Hex,
} from 'viem'
import { baseSepolia } from 'viem/chains'
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts'
import { topUpAmount } from './topUpPlan.js'
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// ── CLI ARGS ──────────────────────────────────────────────────
function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}
const N_BOTS       = Number(arg('--bots',     '50'))
const DURATION_STR = arg('--duration', '48h')
const TICK_MS      = parseDuration(arg('--tick',  '30s'))
const RUN_MS       = parseDuration(DURATION_STR)
const LOG_FILE     = arg('--log', `logs/soak-${Date.now()}.jsonl`)
const MIN_BET_USDC = Number(arg('--min-bet', '1'))
const MAX_BET_USDC = Number(arg('--max-bet', '100'))

// Funding floors and targets. These used to be four literals inline in
// fundIfNeeded (0.005/0.01 ETH, 20/100 USDC), which is what made `--bots 50`
// read as "needs 0.5 ETH and 5,000 USDC of faucet" and kept the soak from ever
// running. The ETH target is ~1,600 transactions at Base Sepolia's 0.006 gwei;
// the USDC target follows the bet size so a bot is always able to afford a few
// concurrent positions and never asks for stake it cannot bet.
const ETH_FLOOR    = parseEther(arg('--eth-floor',  '0.0005'))
const ETH_TARGET   = parseEther(arg('--eth-target', '0.002'))
const USDC_FLOOR   = parseUnits(arg('--usdc-floor',  String(MAX_BET_USDC)),     6)
const USDC_TARGET  = parseUnits(arg('--usdc-target', String(MAX_BET_USDC * 3)), 6)

function parseDuration(s: string): number {
  const m = /^(\d+)\s*(s|m|h|d|ms)$/i.exec(s.trim())
  if (!m) throw new Error(`bad duration: ${s}`)
  const n = Number(m[1]), u = m[2]!.toLowerCase()
  switch (u) {
    case 'ms': return n
    case 's':  return n * 1_000
    case 'm':  return n * 60_000
    case 'h':  return n * 3_600_000
    case 'd':  return n * 86_400_000
    default:   throw new Error(`unknown unit: ${u}`)
  }
}

// ── ABIS (extract only the calls we exercise) ────────────────
const FACTORY_ABI = [
  { name: 'getAllFeedIds', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32[]' }] },
  { name: 'getActiveMarkets', type: 'function', stateMutability: 'view', inputs: [{ name: 'feedId', type: 'bytes32' }], outputs: [{ type: 'address[]' }] },
] as const

const MARKET_ABI = [
  { name: 'pythFeedId', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'getTraderOrders', type: 'function', stateMutability: 'view', inputs: [{ name: 'trader', type: 'address' }], outputs: [{ type: 'uint256[]' }] },
  {
    name: 'getOrder', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'orderId', type: 'uint256' }],
    outputs: [{
      name: '', type: 'tuple',
      components: [
        { name: 'trader',             type: 'address' },
        { name: 'direction',          type: 'uint8'   },
        { name: 'amount',             type: 'uint256' },
        { name: 'filledAmount',       type: 'uint256' },
        { name: 'referrer',           type: 'address' },
        { name: 'status',             type: 'uint8'   },
        { name: 'placedAt',           type: 'uint256' },
        { name: 'matchId',            type: 'uint256' },
        { name: 'pendingSettlements', type: 'uint256' },
        { name: 'payout',             type: 'uint256' },
        { name: 'unmatchedRefunded',  type: 'bool'    },
        // Audit L01 (2026-09-28): trailing fields added to the Order struct.
        { name: 'expectedPrice',      type: 'uint256' },
        { name: 'slippageBps',        type: 'uint256' },
      ],
    }],
  },
  {
    name: 'placeBet', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'dir',           type: 'uint8'   },
      { name: 'amount',        type: 'uint256' },
      { name: 'referrer',      type: 'address' },
      { name: 'expectedPrice', type: 'uint256' },
      { name: 'slippageBps',   type: 'uint256' },
    ],
    outputs: [{ name: 'orderId', type: 'uint256' }],
  },
  { name: 'claim',         type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'orderId', type: 'uint256' }], outputs: [] },
  { name: 'refundExpired', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'orderId', type: 'uint256' }], outputs: [] },
] as const

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'transfer',  type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'approve',   type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

// ── ENV ───────────────────────────────────────────────────────
const RPC          = process.env.BASE_RPC_URL || 'https://sepolia.base.org'
const USDC         = process.env.USDC_ADDRESS as Address
const FACTORY      = process.env.MARKET_FACTORY as Address
const HERMES       = process.env.PYTH_HERMES_URL || 'https://hermes.pyth.network'
const FAUCET_KEY   = process.env.USDC_FAUCET_KEY as Hex
const BOT_MNEMONIC = process.env.BOT_MNEMONIC // BIP-39 seed phrase
const SLIPPAGE_BPS = 500n // 5% — wide because we don't pre-fetch prices off-chain

if (!FACTORY || !USDC) throw new Error('MARKET_FACTORY and USDC_ADDRESS must be set')
if (!BOT_MNEMONIC) throw new Error('BOT_MNEMONIC must be set')

// ── CLIENTS ───────────────────────────────────────────────────
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) })

interface Bot {
  index: number
  address: Address
  client: ReturnType<typeof createWalletClient>
}

function mkBot(i: number): Bot {
  const account = mnemonicToAccount(BOT_MNEMONIC!, { addressIndex: i })
  const client = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) })
  return { index: i, address: account.address, client }
}

// ── METRICS ───────────────────────────────────────────────────
/**
 * The `OrderbookMarket.getOrder` fields this harness reads.
 *
 * This read used to be `as any`, which is worse here than it looks: TypeScript
 * types `any - any` as `number`, so `amount - filledAmount` came out a number
 * and the bigint accumulator it feeds silently stopped being checked. The
 * values are real bigints at runtime, so nothing was broken - but nothing was
 * verified either, and until `scripts/` joined the workspace nothing typechecked
 * this file at all.
 */
interface OnchainOrder {
  status:            number
  amount:            bigint
  filledAmount:      bigint
  payout:            bigint
  placedAt:          bigint
  unmatchedRefunded: boolean
}

interface Metrics {
  startTs: number
  placeBetOk: number
  placeBetFail: number
  claimOk: number
  claimFail: number
  refundOk: number
  refundFail: number
  totalDepositedWei: bigint
  totalPaidOutWei: bigint
  totalRefundedWei: bigint
}
const metrics: Metrics = {
  startTs: Date.now(),
  placeBetOk: 0, placeBetFail: 0,
  claimOk: 0, claimFail: 0,
  refundOk: 0, refundFail: 0,
  totalDepositedWei: 0n,
  totalPaidOutWei: 0n,
  totalRefundedWei: 0n,
}

if (!existsSync(dirname(LOG_FILE))) mkdirSync(dirname(LOG_FILE), { recursive: true })
writeFileSync(LOG_FILE, '') // truncate

function log(event: string, data: Record<string, unknown>) {
  const line = JSON.stringify({ ts: Date.now(), event, ...data })
  appendFileSync(LOG_FILE, line + '\n')
}

// ── FUNDING ───────────────────────────────────────────────────
async function fundIfNeeded(bot: Bot) {
  const [ethBal, usdcBal] = await Promise.all([
    publicClient.getBalance({ address: bot.address }),
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [bot.address] }),
  ])

  const faucet = privateKeyToAccount(FAUCET_KEY)
  const faucetClient = createWalletClient({ account: faucet, chain: baseSepolia, transport: http(RPC) })

  const ethTopUp = topUpAmount(ethBal, ETH_FLOOR, ETH_TARGET)
  if (ethTopUp > 0n) {
    const hash = await faucetClient.sendTransaction({ to: bot.address, value: ethTopUp })
    await publicClient.waitForTransactionReceipt({ hash })
    log('fund_eth', { bot: bot.index, wei: ethTopUp.toString(), hash })
  }

  const usdcTopUp = topUpAmount(usdcBal as bigint, USDC_FLOOR, USDC_TARGET)
  if (usdcTopUp > 0n) {
    const hash = await faucetClient.writeContract({
      address: USDC, abi: ERC20_ABI, functionName: 'transfer',
      args: [bot.address, usdcTopUp],
    })
    await publicClient.waitForTransactionReceipt({ hash })
    log('fund_usdc', { bot: bot.index, base: usdcTopUp.toString(), hash })
  }
}

// ── MARKETS ───────────────────────────────────────────────────
async function pickRandomMarket(): Promise<{ market: Address; feedId: Hex } | null> {
  const feeds = await publicClient.readContract({
    address: FACTORY, abi: FACTORY_ABI, functionName: 'getAllFeedIds',
  }) as readonly Hex[]
  if (feeds.length === 0) return null
  const feedId = feeds[Math.floor(Math.random() * feeds.length)]!
  const markets = await publicClient.readContract({
    address: FACTORY, abi: FACTORY_ABI, functionName: 'getActiveMarkets', args: [feedId],
  }) as readonly Address[]
  if (markets.length === 0) return null
  const market = markets[Math.floor(Math.random() * markets.length)]!
  return { market, feedId }
}

async function getCurrentPrice(feedId: Hex): Promise<bigint | null> {
  try {
    const r = await fetch(`${HERMES}/v2/updates/price/latest?ids[]=${feedId}&encoding=hex&parsed=true`)
    if (!r.ok) return null
    const j = await r.json() as { parsed?: { price: { price: string; expo: number } }[] }
    const p = j.parsed?.[0]?.price
    if (!p) return null
    const raw = BigInt(p.price)
    const expo = p.expo
    if (expo < 0) {
      const div = 10n ** BigInt(-expo)
      return (raw * 10n ** 18n) / div
    }
    return raw * 10n ** 18n * (10n ** BigInt(expo))
  } catch {
    return null
  }
}

// ── BOT ACTIONS ──────────────────────────────────────────────
async function actPlaceBet(bot: Bot) {
  const pick = await pickRandomMarket()
  if (!pick) return
  const price = await getCurrentPrice(pick.feedId)
  if (!price || price === 0n) return

  const amount = parseUnits(String(MIN_BET_USDC + Math.floor(Math.random() * (MAX_BET_USDC - MIN_BET_USDC))), 6)
  const dir: 0 | 1 = Math.random() < 0.5 ? 0 : 1

  // Ensure allowance.
  const allowance = await publicClient.readContract({
    address: USDC, abi: ERC20_ABI, functionName: 'allowance', args: [bot.address, pick.market],
  })
  if (allowance < amount) {
    const hash = await bot.client.writeContract({
      address: USDC, abi: ERC20_ABI, functionName: 'approve',
      args: [pick.market, 2n ** 256n - 1n],
      chain: baseSepolia, account: bot.address,
    })
    await publicClient.waitForTransactionReceipt({ hash })
  }

  try {
    const hash = await bot.client.writeContract({
      address: pick.market, abi: MARKET_ABI, functionName: 'placeBet',
      args: [dir, amount, '0x0000000000000000000000000000000000000000' as Address, price, SLIPPAGE_BPS],
      chain: baseSepolia, account: bot.address,
    })
    await publicClient.waitForTransactionReceipt({ hash })
    metrics.placeBetOk++
    metrics.totalDepositedWei += amount
    log('place_bet_ok', { bot: bot.index, market: pick.market, amount: amount.toString(), dir, hash })
  } catch (err: any) {
    metrics.placeBetFail++
    log('place_bet_fail', { bot: bot.index, market: pick.market, reason: err?.shortMessage || String(err) })
  }
}

async function actSweepOrders(bot: Bot) {
  const pick = await pickRandomMarket()
  if (!pick) return
  const orderIds = await publicClient.readContract({
    address: pick.market, abi: MARKET_ABI, functionName: 'getTraderOrders', args: [bot.address],
  }) as readonly bigint[]

  for (const id of orderIds.slice(-10)) { // limit per tick
    try {
      const o = await publicClient.readContract({
        address: pick.market, abi: MARKET_ABI, functionName: 'getOrder', args: [id],
      }) as unknown as OnchainOrder
      // SETTLED with positive payout → claim
      if (o.status === 2 && o.payout > 0n) {
        const hash = await bot.client.writeContract({
          address: pick.market, abi: MARKET_ABI, functionName: 'claim', args: [id],
          chain: baseSepolia, account: bot.address,
        })
        await publicClient.waitForTransactionReceipt({ hash })
        metrics.claimOk++
        metrics.totalPaidOutWei += o.payout
        log('claim_ok', { bot: bot.index, market: pick.market, orderId: id.toString(), payout: o.payout.toString(), hash })
      }
      // PENDING expired (placedAt + 5min < now) → refundExpired
      else if (o.status === 0 && !o.unmatchedRefunded) {
        const now = Math.floor(Date.now() / 1000)
        if (now > Number(o.placedAt) + 300) {
          const hash = await bot.client.writeContract({
            address: pick.market, abi: MARKET_ABI, functionName: 'refundExpired', args: [id],
            chain: baseSepolia, account: bot.address,
          })
          await publicClient.waitForTransactionReceipt({ hash })
          metrics.refundOk++
          metrics.totalRefundedWei += (o.amount - o.filledAmount)
          log('refund_ok', { bot: bot.index, market: pick.market, orderId: id.toString(), hash })
        }
      }
    } catch (err: any) {
      // Per-order failures are common (race with keeper) — just count them.
      if (err?.shortMessage?.includes('claim') || err?.shortMessage?.includes('refund')) {
        metrics.claimFail++
      }
    }
  }
}

// ── MAIN LOOP ─────────────────────────────────────────────────
async function botTick(bot: Bot) {
  const roll = Math.random()
  if (roll < 0.7) await actPlaceBet(bot)
  else if (roll < 0.95) await actSweepOrders(bot)
}

async function main() {
  console.log(`[bot-harness] bootstrapping ${N_BOTS} bots, RUN ${DURATION_STR}, TICK ${TICK_MS}ms`)
  const bots: Bot[] = []
  for (let i = 0; i < N_BOTS; i++) bots.push(mkBot(i))

  console.log('[bot-harness] funding bots (one-time)…')
  for (const b of bots) {
    try { await fundIfNeeded(b) } catch (err) { console.error(`fund ${b.index} failed`, err) }
  }

  const endAt = Date.now() + RUN_MS
  let tickCount = 0

  while (Date.now() < endAt) {
    tickCount++
    await Promise.allSettled(bots.map((b) => botTick(b)))

    if (tickCount % 10 === 0) {
      log('metrics', {
        ...metrics,
        totalDepositedUsdc: formatUnits(metrics.totalDepositedWei, 6),
        totalPaidOutUsdc:   formatUnits(metrics.totalPaidOutWei,   6),
        totalRefundedUsdc:  formatUnits(metrics.totalRefundedWei,  6),
      })
      console.log(`[tick ${tickCount}] bets ok/fail: ${metrics.placeBetOk}/${metrics.placeBetFail}, claims: ${metrics.claimOk}, refunds: ${metrics.refundOk}`)
    }

    await new Promise((r) => setTimeout(r, TICK_MS))
  }

  log('end', { ...metrics, durationMs: Date.now() - metrics.startTs })
  console.log('[bot-harness] done')
}

main().catch((err) => { console.error(err); process.exit(1) })
