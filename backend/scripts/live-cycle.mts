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
 *   PHASE=pvp   npx tsx scripts/live-cycle.mts      # the whole cycle, two wallets
 *   PHASE=fund  npx tsx scripts/live-cycle.mts      # deposit into the LP pool
 *   PHASE=bet   npx tsx scripts/live-cycle.mts      # place one real bet
 *   PHASE=watch npx tsx scripts/live-cycle.mts      # follow it to payout
 *
 * PHASE=pvp is the one that needs nothing but two funded wallets. `placeBet`
 * matches against the PvP queue before it ever looks at the pool, so two
 * opposite bets on the same market fill each other and the whole loop -
 * placement, match, settlement, payout - runs with an empty LP pool and
 * 2 x BET_AMOUNT of USDC. The LP path needs MIN_DEPOSIT (50 USDC) on top.
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
import { readFileSync } from 'node:fs'
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
// Two USDC a side: above MIN_BET so the fee arithmetic is visible in the
// ledger, small enough that a 10-USDC-a-day faucet funds several runs.
const PVP_AMOUNT = BigInt(Math.round(Number(process.env.PVP_AMOUNT ?? '2')   * 1e6))
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
  // The full 13-field Order: expectedPrice and slippageBps were appended (audit L01) and a stale copy decodes wrongly.
  'function getOrder(uint256 orderId) view returns ((address trader,uint8 direction,uint256 amount,uint256 filledAmount,address referrer,uint8 status,uint256 placedAt,uint256 matchId,uint256 pendingSettlements,uint256 payout,bool unmatchedRefunded,uint256 expectedPrice,uint256 slippageBps))',
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

/**
 * A named signer. PHASE=pvp needs two of them at once, so the acting account
 * cannot stay module-level the way the single-wallet phases assume.
 */
function makeSigner(name: string, pk: string) {
  const acct = privateKeyToAccount(pk as `0x${string}`)
  return {
    name,
    address: acct.address,
    wallet:  createWalletClient({ account: acct, chain: CHAIN, transport: http(RPC) }),
  }
}
type Signer = ReturnType<typeof makeSigner>

/**
 * The two test wallets, read from .testwallets/wallets.env unless overridden.
 * That file is gitignored and holds throwaway Sepolia keys; nothing here ever
 * touches an account that matters.
 */
function pvpSigners(): [Signer, Signer] {
  const a = process.env.KEY_A
  const b = process.env.KEY_B
  if (a && b) return [makeSigner('A', a), makeSigner('B', b)]

  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../.testwallets/wallets.env')
  const text = readFileSync(path, 'utf8')
  const pick = (n: number) => {
    const m = text.match(new RegExp(`^wallet${n}_private_key=(0x[0-9a-fA-F]+)`, 'm'))
    if (!m) throw new Error(`wallet${n}_private_key not found in ${path}`)
    return m[1]
  }
  // 1 and 3 are the pair that hold both USDC and gas; 2 has no ETH.
  return [makeSigner('A', pick(1)), makeSigner('B', pick(3))]
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
async function pickMarket(minLeadSec = 60): Promise<{ address: Address; closeTime: bigint } | null> {
  const res = await fetch(`${API}/api/markets`)
  if (!res.ok) throw new Error(`GET ${API}/api/markets -> ${res.status}`)
  const rows = (await res.json()) as { address: string; status: string; closeTime: number }[]
  const now = Math.floor(Date.now() / 1000)

  // An explicit MARKET is still looked up here rather than on-chain. The
  // market contract has no closeTime() - it stores `duration`, and when a
  // round actually ends is the indexer's knowledge, not the clone's. The
  // first version of this asked the contract and got a bare `execution
  // reverted`, because that branch had never been run.
  if (process.env.MARKET) {
    const want = (process.env.MARKET as string).toLowerCase()
    const row = rows.find(m => m.address.toLowerCase() === want)
    if (!row) throw new Error(`market ${process.env.MARKET} is not in ${API}/api/markets`)
    return { address: row.address as Address, closeTime: BigInt(row.closeTime) }
  }

  const usable = rows
    .filter(m => m.status === 'OPEN' && m.closeTime > now + minLeadSec)
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


/**
 * The whole loop on two wallets, with an empty LP pool.
 *
 * Places equal and opposite bets on the same market so they fill each other in
 * the PvP queue, waits out the close, waits for the keeper to settle, and
 * claims the winner's payout. Every balance is read before and after, because
 * the point of this script is not that the calls succeeded - it is that the
 * USDC actually moved and the arithmetic is the arithmetic we intended.
 */
async function pvp() {
  const [A, B] = pvpSigners()
  const amount = PVP_AMOUNT
  // Resume a run whose bets already landed. Placement is the only irreversible
  // half; re-running it to watch a settlement would burn USDC to learn nothing.
  const resume = process.env.ORDER_A && process.env.ORDER_B && process.env.MARKET

  // Four transactions have to land before close: approve+bet, twice. At Base
  // Sepolia block times that is well under a minute, but a market closing in
  // 90 seconds leaves no room for a retry.
  const market = await pickMarket(150)
  if (!market) throw new Error('no open market closing more than 150s out')

  const feedId = await pub.readContract({ address: market.address, abi: MARKET_ABI, functionName: 'feedId' })
  const symbol = bytes32ToFeedId(feedId)
  const closesIn = Number(market.closeTime) - Math.floor(Date.now() / 1000)

  console.log(`\n-- PvP cycle ----------------------------------`)
  console.log(`market   ${market.address}`)
  console.log(`feed     ${symbol}`)
  console.log(`closes   in ${Math.round(closesIn / 60)} min`)
  console.log(`stake    ${usd(amount)} each way`)
  console.log(`A (UP)   ${A.address}`)
  console.log(`B (DOWN) ${B.address}`)

  const beforeA = await usdcBalanceAt(A.address)
  const beforeB = await usdcBalanceAt(B.address)
  console.log(`\nbalances before   A ${usd(beforeA)}   B ${usd(beforeB)}`)

  if (beforeA < amount) throw new Error(`A has ${usd(beforeA)}, needs ${usd(amount)}`)
  if (beforeB < amount) throw new Error(`B has ${usd(beforeB)}, needs ${usd(amount)}`)

  let orderA: bigint
  let orderB: bigint
  let placedAt: bigint | undefined
  if (resume) {
    orderA = BigInt(process.env.ORDER_A as string)
    orderB = BigInt(process.env.ORDER_B as string)
    console.log(`\nresuming: A #${orderA}, B #${orderB} - nothing new was placed`)
  } else {
    const a = await placeBetAs(A, market.address, symbol, 0, amount)
    const b = await placeBetAs(B, market.address, symbol, 1, amount)
    orderA = a.id
    orderB = b.id
    // Matching happens inside B's transaction, so B's block is the earliest
    // one at which both orders read as filled.
    placedAt = b.block > a.block ? b.block : a.block
  }

  // -- the match ------------------------------------------------
  const STATUS = ['PENDING', 'MATCHED', 'SETTLED', 'REFUNDED', 'CLAIMED']
  const oA = await getOrderAt(market.address, orderA, placedAt)
  const oB = await getOrderAt(market.address, orderB, placedAt)
  console.log(`\nafter placement`)
  console.log(`  A #${orderA}  ${STATUS[oA.status]}  filled ${usd(oA.filledAmount)}/${usd(oA.amount)}`)
  console.log(`  B #${orderB}  ${STATUS[oB.status]}  filled ${usd(oB.filledAmount)}/${usd(oB.amount)}`)
  if (oA.filledAmount === 0n || oB.filledAmount === 0n) {
    throw new Error('the two orders did not fill each other - PvP matching did not happen')
  }
  console.log(`  matched: ${usd(oA.filledAmount)} each way`)

  // -- close, then settlement -----------------------------------
  const waitFor = Number(market.closeTime) * 1000 - Date.now() + 5_000
  if (waitFor > 0) {
    console.log(`\nwaiting ${Math.round(waitFor / 1000)}s for the market to close...`)
    await new Promise(r => setTimeout(r, waitFor))
  }

  console.log('waiting for the keeper to settle (60s loop)...')
  const deadline = Date.now() + 20 * 60_000
  let settled = false
  while (Date.now() < deadline) {
    const a = await getOrderAt(market.address, orderA)
    const b = await getOrderAt(market.address, orderB)
    if (a.pendingSettlements === 0n && b.pendingSettlements === 0n && a.status >= 2 && b.status >= 2) {
      console.log(`\nsettled`)
      console.log(`  A #${orderA}  ${STATUS[a.status]}  payout ${usd(a.payout)}`)
      console.log(`  B #${orderB}  ${STATUS[b.status]}  payout ${usd(b.payout)}`)
      settled = true
      break
    }
    await new Promise(r => setTimeout(r, 15_000))
  }
  if (!settled) throw new Error('not settled within 20 min - check the keeper logs')

  // -- payout ---------------------------------------------------
  let settledAt = 0n
  for (const s of [A, B]) {
    const id = s.name === 'A' ? orderA : orderB
    const o = await getOrderAt(market.address, id)
    if (o.payout > 0n && o.status !== 4) {
      console.log(`\n${s.name} claiming ${usd(o.payout)}...`)
      const h = await s.wallet.writeContract({ address: market.address, abi: MARKET_ABI, functionName: 'claim', args: [id] })
      const r = await pub.waitForTransactionReceipt({ hash: h })
      if (r.status !== 'success') throw new Error(`claim reverted: ${h}`)
      if (r.blockNumber > settledAt) settledAt = r.blockNumber
      console.log(`  claim ${h}  block ${r.blockNumber}`)
    }
  }

  // Read the closing balances at the block the last claim landed in, so the
  // ledger cannot be written from a replica that has not seen it yet.
  const afterA = await usdcBalanceAt(A.address, settledAt || undefined)
  const afterB = await usdcBalanceAt(B.address, settledAt || undefined)
  const dA = afterA - beforeA
  const dB = afterB - beforeB

  console.log(`\n-- ledger -------------------------------------`)
  console.log(`  A  ${usd(beforeA)} -> ${usd(afterA)}   (${dA >= 0n ? '+' : ''}${usd(dA)})`)
  console.log(`  B  ${usd(beforeB)} -> ${usd(afterB)}   (${dB >= 0n ? '+' : ''}${usd(dB)})`)
  if (resume) {
    // On a resumed run the opening balances were read after the stakes had
    // already left, so a net across the two wallets would read as pure profit.
    // Say so rather than printing a number that flatters the result.
    console.log(`  (opening balances are from the resume point, after both stakes)`)
  } else {
    console.log(`  net across both: ${usd(dA + dB)}`)
  }

  // The fee, taken from the orders rather than inferred from balances: the
  // winner's gross is the whole matched pool, so whatever is missing from the
  // payout is what the protocol kept. Independent of when anything was measured.
  const finalA = await getOrderAt(market.address, orderA)
  const finalB = await getOrderAt(market.address, orderB)
  const gross  = (finalA.filledAmount + finalB.filledAmount)
  const paid   = finalA.payout + finalB.payout
  console.log(`  matched pool ${usd(gross)}, paid out ${usd(paid)}, protocol fee ${usd(gross - paid)}`)
  console.log(`\nFull cycle complete: placed, matched, settled, paid out.`)
}

/**
 * A USDC balance read at a specific block.
 *
 * The same load-balanced RPC that mis-numbered the orders will happily serve a
 * plain balanceOf from a replica a block or two behind, and the first full run
 * of this script reported a completed payout as "+0 USDC" because of it. Asking
 * for an explicit block turns that silence into a retryable error: a replica
 * that does not have the block says so instead of guessing.
 */
async function usdcBalanceAt(who: Address, blockNumber?: bigint): Promise<bigint> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await pub.readContract({
        address: USDC, abi: ERC20, functionName: 'balanceOf', args: [who], blockNumber,
      })
    } catch (err) {
      if (attempt === 9) throw err
      await new Promise(r => setTimeout(r, 1_500))
    }
  }
  throw new Error('unreachable')
}

/**
 * An order read at a specific block, retried.
 *
 * The third place the same load-balanced RPC bit: reading getOrder immediately
 * after a placeBet receipt returned an order with amount 0, and the script
 * concluded that PvP matching had failed when both orders had in fact filled
 * each other completely. Anything read straight after a receipt has to name the
 * block, or a replica that is behind will answer with a plausible lie.
 */
async function getOrderAt(market: Address, id: bigint, blockNumber?: bigint) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await pub.readContract({
        address: market, abi: MARKET_ABI, functionName: 'getOrder', args: [id], blockNumber,
      })
    } catch (err) {
      if (attempt === 9) throw err
      await new Promise(r => setTimeout(r, 1_500))
    }
  }
  throw new Error('unreachable')
}

/** One bet from one signer, approving first if the allowance is short. */
async function placeBetAs(
  s: Signer, market: Address, symbol: string, dir: 0 | 1, amount: bigint,
): Promise<{ id: bigint; block: bigint }> {
  const allowance = await pub.readContract({
    address: USDC, abi: ERC20, functionName: 'allowance', args: [s.address, market],
  })
  if (allowance < amount) {
    const h = await s.wallet.writeContract({ address: USDC, abi: ERC20, functionName: 'approve', args: [market, amount] })
    await pub.waitForTransactionReceipt({ hash: h })
    console.log(`  ${s.name} approve ${h}`)
  }

  // Freshly fetched per bet: the payload carries a signed timestamp and the
  // market rejects one that has gone stale, so reusing A's payload for B is a
  // race against the freshness window.
  const [payload, price] = await Promise.all([fetchPayload(symbol), fetchPrice(symbol)])
  const expectedPrice = BigInt(Math.round(price * 1e8)) * 10n ** 10n

  const data = withPayload(
    encodeFunctionData({
      abi: MARKET_ABI,
      functionName: 'placeBet',
      args: [dir, amount, '0x0000000000000000000000000000000000000000', expectedPrice, 100n],
    }),
    payload,
  )

  const hash = await s.wallet.sendTransaction({ to: market, data, gas: 1_200_000n })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${s.name} placeBet reverted: ${hash}`)

  const orderId = orderIdFromReceipt(r, market)
  console.log(`  ${s.name} bet ${usd(amount)} ${dir === 0 ? 'UP' : 'DOWN'} at $${price}  order #${orderId}  ${hash}`)
  return { id: orderId, block: r.blockNumber }
}

/** keccak256("OrderPlaced(uint256,address,uint8,uint256)") - orderId is topic 1. */
const ORDER_PLACED_TOPIC = '0x2889ad19f411ddebebecb8b577f9b378f8136f7068eb59b277edd8fe158172c8'

/**
 * The order id, taken from the receipt the transaction already returned.
 *
 * The obvious shortcut - read nextOrderId afterwards and subtract one - is a
 * race, and it lost: Base's public RPC is load-balanced, the follow-up
 * eth_call landed on a replica one block behind, and both orders came back
 * numbered one too low. The receipt is not subject to that; it is the record
 * of the block that actually executed.
 */
function orderIdFromReceipt(receipt: { logs: readonly { address: string; topics: readonly string[] }[] }, market: Address): bigint {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== market.toLowerCase()) continue
    if (log.topics[0]?.toLowerCase() !== ORDER_PLACED_TOPIC) continue
    return BigInt(log.topics[1] as string)
  }
  throw new Error('placeBet succeeded but emitted no OrderPlaced - cannot identify the order')
}

const { market } = await preflight()
void market

if (PHASE === 'pvp')   await pvp()
if (PHASE === 'fund')  await fund()
if (PHASE === 'bet')   await bet()
if (PHASE === 'watch') await watch()
if (!PHASE) console.log('\n(preflight only - nothing was signed)')
