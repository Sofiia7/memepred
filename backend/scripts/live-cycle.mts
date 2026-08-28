/**
 * The one thing that has never been done on these contracts: a real bet,
 * carried from placement through matching, settlement and payout.
 *
 * simulate-bet.mts proves the path compiles and verifies - it stops at the USDC
 * transfer on purpose. This does not stop. It is the difference between "the
 * code would work" and "somebody's money went in and came back out".
 *
 *   cd backend
 *   npx tsx scripts/live-cycle.mts                  # preflight only, signs nothing
 *   PHASE=fund  npx tsx scripts/live-cycle.mts      # deposit into the LP pool
 *   PHASE=bet   npx tsx scripts/live-cycle.mts      # place one real bet
 *   PHASE=watch npx tsx scripts/live-cycle.mts      # follow it to payout
 *
 * Preflight is the default and it signs nothing: it reports every balance and
 * every precondition, and names what is missing with the amount. Run it first.
 * Nothing here is irreversible until PHASE is set.
 *
 * Env:
 *   PRIVATE_KEY   the acting account (already in .env)
 *   LP_AMOUNT     USDC to deposit, default 100 (pool MIN_DEPOSIT is 50)
 *   BET_AMOUNT    USDC to bet, default 5
 *   MARKET        market to bet on; default is the open market closing soonest
 *   DIRECTION     UP | DOWN, default UP
 */
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
// The .env lives at the repo root, not in backend/ - dotenv's default lookup
// is relative to cwd and finds nothing when this is run from backend/.
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') })

import {
  createPublicClient, createWalletClient, http, parseAbi,
  encodeFunctionData, formatUnits, type Address,
} from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { fetchPayload, fetchPrice, bytes32ToFeedId, withPayload } from '../src/lib/redstone.js'

const CHAIN   = process.env.CHAIN_ID === '8453' ? base : baseSepolia
const RPC     = process.env.BASE_RPC_URL ?? 'https://sepolia.base.org'
const USDC    = process.env.USDC_ADDRESS   as Address
const POOL    = process.env.LIQUIDITY_POOL as Address
const API     = process.env.API_URL ?? 'https://api.flipthememe.com'

const LP_AMOUNT  = BigInt(Math.round(Number(process.env.LP_AMOUNT  ?? '100') * 1e6))
const BET_AMOUNT = BigInt(Math.round(Number(process.env.BET_AMOUNT ?? '5')   * 1e6))
const DIRECTION  = (process.env.DIRECTION ?? 'UP').toUpperCase() === 'DOWN' ? 1 : 0
const PHASE      = process.env.PHASE ?? ''

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])

const POOL_ABI = parseAbi([
  'function totalAssets() view returns (uint256)',
  'function availableForMatching() view returns (uint256)',
  'function MIN_DEPOSIT() view returns (uint256)',
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
])

const MARKET_ABI = parseAbi([
  'function feedId() view returns (bytes32)',
  'function closeTime() view returns (uint256)',
  'function paused() view returns (bool)',
  'function nextOrderId() view returns (uint256)',
  'function placeBet(uint8 dir, uint256 amount, address referrer, uint256 expectedPrice, uint256 slippageBps) returns (uint256)',
  'function claim(uint256 orderId)',
  'function getOrder(uint256 orderId) view returns ((address trader,uint8 direction,uint256 amount,uint256 filledAmount,address referrer,uint8 status,uint256 placedAt,uint256 matchId,uint256 pendingSettlements,uint256 payout,bool unmatchedRefunded))',
])

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) })

// Preflight is read-only and must work without a key in the environment;
// only the phases that sign need one.
const key = process.env.PRIVATE_KEY as `0x${string}` | undefined
const account = key
  ? privateKeyToAccount(key)
  : { address: (process.env.ACCOUNT ?? '0x0000000000000000000000000000000000000000') as Address }
const wallet = key
  ? createWalletClient({ account: privateKeyToAccount(key), chain: CHAIN, transport: http(RPC) })
  : null

function signer() {
  if (!wallet) throw new Error('PRIVATE_KEY missing - required for PHASE=fund|bet|watch')
  return wallet
}

const usd = (v: bigint) => `${formatUnits(v, 6)} USDC`
const eth = (v: bigint) => `${formatUnits(v, 18)} ETH`

/**
 * Whichever open market closes soonest but not within the next minute.
 *
 * Read from our own /api/markets rather than the factory: MarketFactory only
 * exposes getActiveMarkets(feedId) per feed, and going through the API means
 * this script picks the same market a visitor would see - if the indexer is
 * behind, that shows up here rather than being routed around.
 */
async function pickMarket(): Promise<{ address: Address; closeTime: bigint } | null> {
  if (process.env.MARKET) {
    const address = process.env.MARKET as Address
    const closeTime = await pub.readContract({ address, abi: MARKET_ABI, functionName: 'closeTime' })
    return { address, closeTime }
  }
  const res = await fetch(`${API}/api/markets`)
  if (!res.ok) throw new Error(`GET ${API}/api/markets -> ${res.status}`)
  const rows = (await res.json()) as { address: string; status: string; closeTime: number }[]
  const now = Math.floor(Date.now() / 1000)
  const usable = rows
    .filter(m => m.status === 'OPEN' && m.closeTime > now + 60)
    .sort((a, b) => a.closeTime - b.closeTime)
  const m = usable[0]
  return m ? { address: m.address as Address, closeTime: BigInt(m.closeTime) } : null
}

async function preflight() {
  console.log(`chain    ${CHAIN.name} (${CHAIN.id})`)
  console.log(`account  ${account.address}`)

  const [usdcBal, ethBal, poolAssets, minDeposit, avail] = await Promise.all([
    pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [account.address] }),
    pub.getBalance({ address: account.address }),
    pub.readContract({ address: POOL, abi: POOL_ABI, functionName: 'totalAssets' }),
    pub.readContract({ address: POOL, abi: POOL_ABI, functionName: 'MIN_DEPOSIT' }),
    pub.readContract({ address: POOL, abi: POOL_ABI, functionName: 'availableForMatching' }),
  ])

  console.log(`\nbalances`)
  console.log(`  USDC             ${usd(usdcBal)}`)
  console.log(`  ETH (gas)        ${eth(ethBal)}`)
  console.log(`\npool ${POOL}`)
  console.log(`  totalAssets      ${usd(poolAssets)}`)
  console.log(`  available        ${usd(avail)}`)
  console.log(`  MIN_DEPOSIT      ${usd(minDeposit)}`)

  const market = await pickMarket()
  if (market) {
    const feedId = await pub.readContract({ address: market.address, abi: MARKET_ABI, functionName: 'feedId' })
    const closesIn = Number(market.closeTime) - Math.floor(Date.now() / 1000)
    console.log(`\nmarket ${market.address}`)
    console.log(`  feed             ${bytes32ToFeedId(feedId) || '(unrecognised)'}`)
    console.log(`  closes in        ${Math.round(closesIn / 60)} min`)
  } else {
    console.log(`\nmarket             none open far enough out`)
  }

  // ── what is missing, with numbers ────────────────────────────────
  const blockers: string[] = []
  const need = LP_AMOUNT + BET_AMOUNT
  if (usdcBal < need) {
    blockers.push(
      `USDC: have ${usd(usdcBal)}, need ${usd(need)} ` +
      `(${usd(LP_AMOUNT)} for the pool + ${usd(BET_AMOUNT)} to bet). ` +
      `Base Sepolia USDC comes from Circle's faucet: faucet.circle.com`,
    )
  }
  if (poolAssets === 0n && LP_AMOUNT < minDeposit) {
    blockers.push(`LP_AMOUNT ${usd(LP_AMOUNT)} is below MIN_DEPOSIT ${usd(minDeposit)}`)
  }
  if (ethBal < 2_000_000_000_000_000n) {
    blockers.push(`ETH for gas: have ${eth(ethBal)}, want at least 0.002`)
  }
  if (!market) blockers.push('no open market closing more than a minute out')

  console.log('')
  if (blockers.length === 0) {
    console.log('READY. Run with PHASE=fund, then PHASE=bet, then PHASE=watch.')
  } else {
    console.log('BLOCKED:')
    for (const b of blockers) console.log(`  - ${b}`)
  }
  return { market, usdcBal, poolAssets }
}

async function fund() {
  const allowance = await pub.readContract({
    address: USDC, abi: ERC20, functionName: 'allowance', args: [account.address, POOL],
  })
  if (allowance < LP_AMOUNT) {
    console.log(`approving ${usd(LP_AMOUNT)} to the pool…`)
    const h = await signer().writeContract({ address: USDC, abi: ERC20, functionName: 'approve', args: [POOL, LP_AMOUNT] })
    await pub.waitForTransactionReceipt({ hash: h })
    console.log(`  approve ${h}`)
  }

  console.log(`depositing ${usd(LP_AMOUNT)}…`)
  const h = await signer().writeContract({
    address: POOL, abi: POOL_ABI, functionName: 'deposit', args: [LP_AMOUNT, account.address],
  })
  const r = await pub.waitForTransactionReceipt({ hash: h })
  if (r.status !== 'success') throw new Error(`deposit reverted: ${h}`)

  const assets = await pub.readContract({ address: POOL, abi: POOL_ABI, functionName: 'totalAssets' })
  console.log(`  deposit ${h}`)
  console.log(`  pool totalAssets now ${usd(assets)}`)
}

async function bet() {
  const market = await pickMarket()
  if (!market) throw new Error('no open market')

  const feedId = await pub.readContract({ address: market.address, abi: MARKET_ABI, functionName: 'feedId' })
  const symbol = bytes32ToFeedId(feedId)
  const [payload, price] = await Promise.all([fetchPayload(symbol), fetchPrice(symbol)])
  const expectedPrice = BigInt(Math.round(price * 1e8)) * 10n ** 10n

  const allowance = await pub.readContract({
    address: USDC, abi: ERC20, functionName: 'allowance', args: [account.address, market.address],
  })
  if (allowance < BET_AMOUNT) {
    const h = await signer().writeContract({
      address: USDC, abi: ERC20, functionName: 'approve', args: [market.address, BET_AMOUNT],
    })
    await pub.waitForTransactionReceipt({ hash: h })
    console.log(`  approve ${h}`)
  }

  // The signed price rides on the calldata, so this cannot go through
  // writeContract - the same reason keeper/onchainPriceRecorder builds it by
  // hand. Reusing withPayload keeps the two in step.
  const data = withPayload(
    encodeFunctionData({
      abi: MARKET_ABI,
      functionName: 'placeBet',
      args: [DIRECTION, BET_AMOUNT, '0x0000000000000000000000000000000000000000', expectedPrice, 100n],
    }),
    payload,
  )

  console.log(`betting ${usd(BET_AMOUNT)} ${DIRECTION === 0 ? 'UP' : 'DOWN'} on ${symbol} at $${price}`)
  const hash = await signer().sendTransaction({ to: market.address, data, gas: 1_200_000n })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`placeBet reverted: ${hash}`)

  const nextId = await pub.readContract({ address: market.address, abi: MARKET_ABI, functionName: 'nextOrderId' })
  console.log(`  placeBet ${hash}`)
  console.log(`  order #${nextId - 1n} on ${market.address}`)
  console.log(`\n  MARKET=${market.address} ORDER=${nextId - 1n} PHASE=watch npx tsx scripts/live-cycle.mts`)
}

async function watch() {
  const address = process.env.MARKET as Address
  const orderId = BigInt(process.env.ORDER ?? '0')
  if (!address || !orderId) throw new Error('set MARKET and ORDER (printed by PHASE=bet)')

  const STATUS = ['PENDING', 'MATCHED', 'SETTLED', 'REFUNDED', 'CLAIMED']
  let last = ''
  const deadline = Date.now() + 90 * 60_000

  while (Date.now() < deadline) {
    const o = await pub.readContract({ address, abi: MARKET_ABI, functionName: 'getOrder', args: [orderId] })
    const line = `status=${STATUS[o.status] ?? o.status} filled=${usd(o.filledAmount)}/${usd(o.amount)} ` +
                 `pending=${o.pendingSettlements} payout=${usd(o.payout)}`
    if (line !== last) { console.log(`  ${new Date().toISOString()}  ${line}`); last = line }

    if (o.pendingSettlements === 0n && o.filledAmount > 0n && o.payout > 0n) {
      console.log(`\nclaiming ${usd(o.payout)}…`)
      const h = await signer().writeContract({ address, abi: MARKET_ABI, functionName: 'claim', args: [orderId] })
      const r = await pub.waitForTransactionReceipt({ hash: h })
      if (r.status !== 'success') throw new Error(`claim reverted: ${h}`)
      const bal = await pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [account.address] })
      console.log(`  claim ${h}`)
      console.log(`  USDC balance now ${usd(bal)}`)
      console.log('\nFull cycle complete: placed, matched, settled, paid out.')
      return
    }
    if (o.pendingSettlements === 0n && o.filledAmount === 0n && o.unmatchedRefunded) {
      console.log('\nOrder expired unmatched and was refunded. Nothing matched it - fund the LP pool, or place both sides.')
      return
    }
    await new Promise(r => setTimeout(r, 15_000))
  }
  console.log('\nGave up after 90 minutes. The keeper settles on a 60s loop; check its logs.')
}

const { market } = await preflight()
void market

if (PHASE === 'fund')  await fund()
if (PHASE === 'bet')   await bet()
if (PHASE === 'watch') await watch()
if (!PHASE) console.log('\n(preflight only - nothing was signed)')
