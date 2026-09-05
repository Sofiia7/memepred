/**
 * The Robinhood Chain counterpart of live-cycle.mts: a real bet on a real
 * chain, carried from placement through matching, settlement and payout.
 *
 *   cd backend
 *   npx tsx scripts/rhc-live-cycle.mts                # preflight, signs nothing
 *   PHASE=fund   npx tsx scripts/rhc-live-cycle.mts   # gas + WETH to the counterparty
 *   PHASE=market npx tsx scripts/rhc-live-cycle.mts   # create the markets
 *   PHASE=unpause npx tsx scripts/rhc-live-cycle.mts  # undo an emergency stop
 *   PHASE=grace  npx tsx scripts/rhc-live-cycle.mts   # strand a match, start the 24h clock
 *   PHASE=refund npx tsx scripts/rhc-live-cycle.mts   # claim it a day later
 *   PHASE=pvp    npx tsx scripts/rhc-live-cycle.mts   # the whole cycle
 *   PHASE=batch  npx tsx scripts/rhc-live-cycle.mts   # marginal settlement gas, live
 *
 * Preflight is the default and it signs nothing. It reports every balance and
 * every gate the factory will apply, naming what is missing and by how much,
 * because the failure this script exists to avoid is discovering a missing
 * precondition halfway through a sequence that has already spent money.
 *
 * The counterparty is the keeper wallet rather than a third account: it already
 * needs gas on this chain to settle, so funding it is work that has to happen
 * anyway, and using it as the other side of a bet costs nothing extra.
 *
 * Env:
 *   PRIVATE_KEY, KEEPER_PRIVATE_KEY   both already in .env
 *   RHC_FIXTURE_POOL                  the pool to trade on
 *   BET_AMOUNT                        WETH per side, default MIN_BET
 *   DURATION                          market duration in seconds, default 60
 */
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
// The .env lives at the repo root, not in backend/ - dotenv's default lookup is
// relative to cwd and finds nothing when this is run from backend/.
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') })

import {
  createPublicClient, createWalletClient, http, parseAbi, formatEther, parseEther,
  type Address, type Hash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { robinhoodChainTestnet, robinhoodChain } from '../src/chainProfile.js'
import { POOL_MARKET_FACTORY_ABI } from '../src/lib/poolFactoryAbi.js'

const chain = process.env.CHAIN_ID === '4663' ? robinhoodChain : robinhoodChainTestnet
const rpc = process.env.RHC_RPC_URL ?? chain.rpcUrls.default.http[0]
const pub = createPublicClient({ chain, transport: http(rpc) })

// RHC_-prefixed first: the shared .env still points MARKET_FACTORY and
// ORACLE_RESOLVER at the Base deployment, and a real rhc backend would run with
// an env file of its own where the plain names are the right ones.
const FACTORY = (process.env.RHC_MARKET_FACTORY ?? process.env.MARKET_FACTORY) as Address
const RESOLVER = (process.env.RHC_ORACLE_RESOLVER ?? process.env.ORACLE_RESOLVER) as Address
const WETH = process.env.RHC_WETH_ADDRESS as Address
const POOL = process.env.RHC_FIXTURE_POOL as Address
const DURATION = BigInt(process.env.DURATION ?? '60')

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
])

const MARKET = parseAbi([
  'function placeBet(uint8 dir,uint256 amount,address referrer,uint256 expectedPrice,uint256 slippageBps) returns (uint256)',
  'function claim(uint256 orderId)',
  'function duration() view returns (uint256)',
  'function feedId() view returns (bytes32)',
  'function MIN_BET() view returns (uint256)',
  'function MAX_BET() view returns (uint256)',
  'function getMatch(uint256) view returns (uint256,uint256,uint256,uint256,uint256,uint256,bool,bool,bool)',
  'function getReadySettlements(uint256,uint256) view returns (uint256[])',
])

const RESOLVER_ABI = parseAbi([
  'function spotPriceWad(bytes32) view returns (uint256)',
  'function resolveOrderbookMarketBatch(address,uint256) returns (uint256)',
])

const signer = (name: string, key: string) => {
  const account = privateKeyToAccount(key.startsWith('0x') ? (key as `0x${string}`) : (`0x${key}` as `0x${string}`))
  return { name, account, wallet: createWalletClient({ account, chain, transport: http(rpc) }) }
}

const A = signer('A (deployer)', process.env.PRIVATE_KEY!)
const B = signer('B (keeper)', process.env.KEEPER_PRIVATE_KEY!)

const eth = (v: bigint) => `${formatEther(v)} ETH`
const feedIdFor = (pool: Address) => `0x${pool.slice(2).toLowerCase().padStart(64, '0')}` as `0x${string}`

async function wait(hash: Hash, what: string) {
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${what} reverted: ${hash}`)
  console.log(`   ${what}: ${r.gasUsed} gas`)
  return r
}

// ── PREFLIGHT ──────────────────────────────────────────────
async function preflight() {
  console.log(`chain    ${chain.name} (${chain.id})`)
  console.log(`factory  ${FACTORY}`)
  console.log(`resolver ${RESOLVER}`)
  console.log(`pool     ${POOL}\n`)

  for (const s of [A, B]) {
    const [gas, weth] = await Promise.all([
      pub.getBalance({ address: s.account.address }),
      pub.readContract({ address: WETH, abi: ERC20, functionName: 'balanceOf', args: [s.account.address] }),
    ])
    console.log(`${s.name.padEnd(14)} ${s.account.address}`)
    console.log(`   gas  ${eth(gas)}${gas === 0n ? '   <- needs gas, run PHASE=fund' : ''}`)
    console.log(`   WETH ${formatEther(weth)}`)
  }

  console.log('\n-- factory gates -------------------------------')
  const depth = await pub.readContract({ address: FACTORY, abi: POOL_MARKET_FACTORY_ABI, functionName: 'wethDepth', args: [POOL] })
  console.log(`   wethDepth        ${formatEther(depth)} ETH`)
  for (const d of [60n, 300n, 900n]) {
    const window = await pub.readContract({ address: FACTORY, abi: POOL_MARKET_FACTORY_ABI, functionName: 'twapWindowFor', args: [d] })
    const ok = await pub.readContract({ address: FACTORY, abi: POOL_MARKET_FACTORY_ABI, functionName: 'canServeWindow', args: [POOL, window] })
    console.log(`   ${d}s market      window ${window}s  servable ${ok}`)
  }

  const markets = await pub.readContract({
    address: FACTORY, abi: POOL_MARKET_FACTORY_ABI, functionName: 'getActiveMarkets', args: [feedIdFor(POOL)],
  })
  console.log(`\n-- markets on this pool: ${markets.length} -----------------`)
  for (const m of markets) {
    const dur = await pub.readContract({ address: m, abi: MARKET, functionName: 'duration' })
    console.log(`   ${m}  ${dur}s`)
  }

  const price = await pub.readContract({ address: RESOLVER, abi: RESOLVER_ABI, functionName: 'spotPriceWad', args: [feedIdFor(POOL)] })
  console.log(`\nresolver strike  ${formatEther(price)} WETH per token`)
  return markets
}

// ── PHASES ─────────────────────────────────────────────────
/** Gas for the counterparty, which is also the keeper that has to settle. */
async function fund() {
  const need = parseEther(process.env.FUND_GAS ?? '0.002')
  const have = await pub.getBalance({ address: B.account.address })
  if (have >= need) return console.log(`B already holds ${eth(have)}, nothing to send`)

  console.log(`sending ${eth(need - have)} to ${B.account.address}`)
  await wait(await A.wallet.sendTransaction({ to: B.account.address, value: need - have }), 'gas transfer')
}

async function createMarkets() {
  for (const d of [DURATION]) {
    console.log(`createMarket(${POOL}, ${d})`)
    const hash = await A.wallet.writeContract({
      address: FACTORY, abi: POOL_MARKET_FACTORY_ABI, functionName: 'createMarket', args: [POOL, d],
    })
    await wait(hash, `createMarket ${d}s`)
  }
}

async function pvp(market: Address) {
  const [minBet, strike] = await Promise.all([
    pub.readContract({ address: market, abi: MARKET, functionName: 'MIN_BET' }),
    pub.readContract({ address: RESOLVER, abi: RESOLVER_ABI, functionName: 'spotPriceWad', args: [feedIdFor(POOL)] }),
  ])
  const amount = process.env.BET_AMOUNT ? parseEther(process.env.BET_AMOUNT) : minBet

  console.log(`\n-- PvP cycle -----------------------------------`)
  console.log(`market ${market}`)
  console.log(`stake  ${formatEther(amount)} WETH each way (MIN_BET ${formatEther(minBet)})`)
  console.log(`strike ${formatEther(strike)}`)

  const before = {
    A: await pub.readContract({ address: WETH, abi: ERC20, functionName: 'balanceOf', args: [A.account.address] }),
    B: await pub.readContract({ address: WETH, abi: ERC20, functionName: 'balanceOf', args: [B.account.address] }),
  }
  console.log(`\nWETH before   A ${formatEther(before.A)}   B ${formatEther(before.B)}`)

  // Approve then bet, each side. No payload, no calldata surgery: this is the
  // whole point of the pool oracle.
  const orders: Record<string, bigint> = {}
  for (const [s, dir] of [[A, 0], [B, 1]] as const) {
    const allowance = await pub.readContract({
      address: WETH, abi: ERC20, functionName: 'allowance', args: [s.account.address, market],
    })
    if (allowance < amount) {
      await wait(await s.wallet.writeContract({
        address: WETH, abi: ERC20, functionName: 'approve', args: [market, 2n ** 255n],
      }), `${s.name} approve`)
    }
    const hash = await s.wallet.writeContract({
      address: market, abi: MARKET, functionName: 'placeBet',
      args: [dir, amount, '0x0000000000000000000000000000000000000000', strike, 300n],
    })
    const r = await wait(hash, `${s.name} placeBet ${dir === 0 ? 'UP' : 'DOWN'}`)
    orders[s.name] = BigInt(r.logs.length) // placeholder; the real id is read below
  }

  const m = await pub.readContract({ address: market, abi: MARKET, functionName: 'getMatch', args: [1n] })
  const settleAt = Number(m[4])
  if (m[2] === 0n) throw new Error('the two bets did not match')
  console.log(`\nmatched: ${formatEther(m[2])} WETH a side, entry ${formatEther(m[3])}, settles at ${new Date(settleAt * 1000).toISOString()}`)

  // Wait out the duration, then settle from the keeper, which holds KEEPER_ROLE.
  const waitMs = (settleAt + 2) * 1000 - Date.now()
  if (waitMs > 0) {
    console.log(`waiting ${Math.ceil(waitMs / 1000)}s for the market to come due...`)
    await new Promise((r) => setTimeout(r, waitMs))
  }

  const ready = await pub.readContract({ address: market, abi: MARKET, functionName: 'getReadySettlements', args: [0n, 10n] })
  console.log(`ready to settle: ${ready.length}`)

  const settleHash = await B.wallet.writeContract({
    address: RESOLVER, abi: RESOLVER_ABI, functionName: 'resolveOrderbookMarketBatch', args: [market, 10n],
  })
  await wait(settleHash, 'settle')

  const after = await pub.readContract({ address: market, abi: MARKET, functionName: 'getMatch', args: [1n] })
  console.log(`\nsettled ${after[6]}   upWon ${after[7]}   exit ${formatEther(after[5])}`)
  if (!after[6]) throw new Error('match did not settle')

  // The winner claims. Order 1 is A's (UP), order 2 is B's (DOWN).
  const winner = after[7] ? A : B
  const winningOrder = after[7] ? 1n : 2n
  await wait(await winner.wallet.writeContract({
    address: market, abi: MARKET, functionName: 'claim', args: [winningOrder],
  }), `${winner.name} claim`)

  const post = {
    A: await pub.readContract({ address: WETH, abi: ERC20, functionName: 'balanceOf', args: [A.account.address] }),
    B: await pub.readContract({ address: WETH, abi: ERC20, functionName: 'balanceOf', args: [B.account.address] }),
  }
  console.log(`\nWETH after    A ${formatEther(post.A)}   B ${formatEther(post.B)}`)
  console.log(`delta         A ${formatEther(post.A - before.A)}   B ${formatEther(post.B - before.B)}`)
  console.log(`\nthe money moved, and the sum is ${formatEther(post.A - before.A + (post.B - before.B))}`)
}

/**
 * The marginal cost of one more match, measured on the chain itself.
 *
 * The forge bench puts it at 105,572 plus an adjustment for the real pool's
 * observation search, and a single live settlement came in at 222,861 - which
 * is not a contradiction (the bench excludes the 21,000 intrinsic and measures
 * warm storage that a fresh transaction pays cold for), but it does mean the
 * bench cannot be the last word. MIN_BET is 50x this number, so it is worth
 * one afternoon of testnet gas to know it rather than derive it.
 */
async function batch(market: Address) {
  const pairs = Number(process.env.PAIRS ?? '5')
  const minBet = await pub.readContract({ address: market, abi: MARKET, functionName: 'MIN_BET' })

  console.log(`
-- batch settlement, ${pairs} pairs ----------------`)
  for (let i = 0; i < pairs; i++) {
    for (const [s, dir] of [[A, 0], [B, 1]] as const) {
      const hash = await s.wallet.writeContract({
        address: market, abi: MARKET, functionName: 'placeBet',
        args: [dir, minBet, '0x0000000000000000000000000000000000000000', parseEther('1'), 300n],
      })
      await pub.waitForTransactionReceipt({ hash })
    }
    process.stdout.write(`
   placed ${i + 1}/${pairs} pairs`)
  }
  console.log()

  // Every match is due `duration` after it matched, so waiting out the last
  // one covers them all.
  const duration = await pub.readContract({ address: market, abi: MARKET, functionName: 'duration' })
  console.log(`   waiting ${duration}s for all matches to come due...`)
  await new Promise((r) => setTimeout(r, (Number(duration) + 3) * 1000))

  const ready = await pub.readContract({ address: market, abi: MARKET, functionName: 'getReadySettlements', args: [0n, 100n] })
  console.log(`   ready: ${ready.length}`)

  const hash = await B.wallet.writeContract({
    address: RESOLVER, abi: RESOLVER_ABI, functionName: 'resolveOrderbookMarketBatch', args: [market, 100n],
  })
  const r = await pub.waitForTransactionReceipt({ hash })
  console.log(`   settled ${ready.length} matches in one tx: ${r.gasUsed} gas`)
  console.log(`   per match: ${r.gasUsed / BigInt(ready.length || 1)}`)
  console.log(`
   compare with a single-match settlement to get the marginal cost.`)
}

/**
 * Undo an emergency stop.
 *
 * Deliberately two steps with two different keys, because the contracts are
 * deliberately asymmetric: a low-trust hot wallet may stop trading, and only
 * the multisig may restart it. The factory's feed flag gates new markets and is
 * the owner's; each market's own pause is the multisig's, and the factory's
 * sweep cannot undo it.
 *
 * Needed already: the watchdog paused every market on this chain before its
 * per-profile ping existed, by asking a RedStone gateway for a symbol decoded
 * out of a pool address and counting the failures. The stop chain worked
 * exactly as designed, which is the good news inside the bad.
 */
async function unpause() {
  const { readFileSync } = await import('node:fs')
  const standin = JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../.testwallets/multisig-standin.json'), 'utf8'),
  ) as { privateKey: string; address: Address }
  const M = signer('multisig', standin.privateKey)

  const feedId = feedIdFor(POOL)
  const paused = await pub.readContract({
    address: FACTORY, abi: parseAbi(['function feedPaused(bytes32) view returns (bool)']),
    functionName: 'feedPaused', args: [feedId],
  })
  console.log(`
feedPaused ${paused}`)

  if (paused) {
    await wait(await A.wallet.writeContract({
      address: FACTORY, abi: parseAbi(['function unpauseFeed(bytes32)']),
      functionName: 'unpauseFeed', args: [feedId],
    }), 'unpauseFeed')
  }

  // The multisig stand-in has never held gas on this chain.
  const gas = await pub.getBalance({ address: M.account.address })
  if (gas < parseEther('0.0002')) {
    await wait(await A.wallet.sendTransaction({ to: M.account.address, value: parseEther('0.0004') }), 'gas to multisig')
  }

  const markets = await pub.readContract({
    address: FACTORY, abi: POOL_MARKET_FACTORY_ABI, functionName: 'getActiveMarkets', args: [feedId],
  })
  for (const m of markets) {
    const isPaused = await pub.readContract({
      address: m, abi: parseAbi(['function paused() view returns (bool)']), functionName: 'paused',
    })
    if (!isPaused) { console.log(`   ${m} already live`); continue }
    await wait(await M.wallet.writeContract({
      address: m, abi: parseAbi(['function unpause()']), functionName: 'unpause',
    }), `unpause ${m}`)
  }
}

/**
 * Set up the one refund path that has never run on any chain.
 *
 * emergencyRefundMatch is how money leaves a match the keeper cannot settle.
 * It needs `block.timestamp > settleAt + SETTLE_GRACE`, and SETTLE_GRACE is a
 * twenty-four hour constant - so it cannot be reached by waiting for the soak,
 * which settles everything it opens, and it cannot be hurried on a real chain.
 *
 * So: match two bets on a pool of its own, then set that pool's liquidity to
 * zero. The resolver refuses to price a drained pool - it quotes whatever the
 * last swap left behind - and emits MatchUnpriceable instead, which is exactly
 * what happens to a token whose pool dies under an open position. A day later
 * the refund is claimable by anyone.
 *
 * Its own pool because doing this to the soak's would stop the soak.
 */
async function grace() {
  const pool = process.env.RHC_GRACE_POOL as Address
  if (!pool) throw new Error('RHC_GRACE_POOL not set; run deploy-rhc.ps1 -Script addpool')

  const markets = await pub.readContract({
    address: FACTORY, abi: POOL_MARKET_FACTORY_ABI, functionName: 'getActiveMarkets',
    args: [feedIdFor(pool)],
  })
  if (!markets.length) throw new Error('no markets on the grace pool yet; poolWatcher creates them')

  // The shortest one: its matches come due soonest, so the 24h clock starts
  // sooner too.
  let market = markets[0]!
  let shortest = await pub.readContract({ address: market, abi: MARKET, functionName: 'duration' })
  for (const m of markets.slice(1)) {
    const d = await pub.readContract({ address: m, abi: MARKET, functionName: 'duration' })
    if (d < shortest) { shortest = d; market = m }
  }

  const [minBet, strike] = await Promise.all([
    pub.readContract({ address: market, abi: MARKET, functionName: 'MIN_BET' }),
    pub.readContract({ address: RESOLVER, abi: RESOLVER_ABI, functionName: 'spotPriceWad', args: [feedIdFor(pool)] }),
  ])

  console.log(`
-- grace setup ---------------------------------`)
  console.log(`pool   ${pool}`)
  console.log(`market ${market} (${shortest}s)`)
  console.log(`stake  ${formatEther(minBet)} WETH each way`)

  for (const [s, dir] of [[A, 0], [B, 1]] as const) {
    const allowance = await pub.readContract({
      address: WETH, abi: ERC20, functionName: 'allowance', args: [s.account.address, market],
    })
    if (allowance < minBet) {
      await wait(await s.wallet.writeContract({
        address: WETH, abi: ERC20, functionName: 'approve', args: [market, 2n ** 255n],
      }), `${s.name} approve`)
    }
    await wait(await s.wallet.writeContract({
      address: market, abi: MARKET, functionName: 'placeBet',
      args: [dir, minBet, '0x0000000000000000000000000000000000000000', strike, 300n],
    }), `${s.name} placeBet ${dir === 0 ? 'UP' : 'DOWN'}`)
  }

  const m = await pub.readContract({ address: market, abi: MARKET, functionName: 'getMatch', args: [1n] })
  if (m[2] === 0n) throw new Error('the two bets did not match')
  const settleAt = Number(m[4])

  // Kill the pool. Only possible because this is a stand-in; a real pool is
  // drained by its own holders, which is the case being reproduced.
  await wait(await A.wallet.writeContract({
    address: pool, abi: parseAbi(['function setLiquidity(uint128)']),
    functionName: 'setLiquidity', args: [0n],
  }), 'drain the pool')

  const grace = await pub.readContract({
    address: market, abi: parseAbi(['function SETTLE_GRACE() view returns (uint256)']),
    functionName: 'SETTLE_GRACE',
  })
  const claimable = settleAt + Number(grace)

  console.log(`
matched ${formatEther(m[2])} WETH a side, settleAt ${new Date(settleAt * 1000).toISOString()}`)
  // Not "the keeper will emit MatchUnpriceable": it simulates first and sends
  // nothing when the simulation settles zero, so that event only ever happens
  // inside the simulation. What the keeper does on chain is step past the
  // window, and it says so in its log:
  //   "1 ready match(es) at offset 0 cannot settle yet - stepping past them"
  console.log(`pool drained; the keeper will now step past this match every tick without sending`)
  console.log(`emergencyRefundMatch becomes callable at ${new Date(claimable * 1000).toISOString()}`)
  console.log(`
then: MARKET=${market} PHASE=refund npx tsx scripts/rhc-live-cycle.mts`)
}

/** Claim the refund the grace phase set up, once the day has passed. */
async function refund() {
  const market = process.env.MARKET as Address
  if (!market) throw new Error('MARKET not set; use the address the grace phase printed')

  const m = await pub.readContract({ address: market, abi: MARKET, functionName: 'getMatch', args: [1n] })
  if (m[6]) throw new Error('that match already settled; it was never unpriceable')

  const grace = await pub.readContract({
    address: market, abi: parseAbi(['function SETTLE_GRACE() view returns (uint256)']),
    functionName: 'SETTLE_GRACE',
  })
  const claimable = Number(m[4]) + Number(grace)
  const now = Math.floor(Date.now() / 1000)
  if (now <= claimable) {
    const left = claimable - now
    throw new Error(`too early by ${Math.ceil(left / 60)} minutes; callable at ${new Date(claimable * 1000).toISOString()}`)
  }

  const before = {
    A: await pub.readContract({ address: WETH, abi: ERC20, functionName: 'balanceOf', args: [A.account.address] }),
    B: await pub.readContract({ address: WETH, abi: ERC20, functionName: 'balanceOf', args: [B.account.address] }),
  }

  // Permissionless on purpose: a refund nobody can trigger is not a refund.
  // Called from A here, but any address would do.
  await wait(await A.wallet.writeContract({
    address: market, abi: parseAbi(['function emergencyRefundMatch(uint256)']),
    functionName: 'emergencyRefundMatch', args: [1n],
  }), 'emergencyRefundMatch')

  const after = {
    A: await pub.readContract({ address: WETH, abi: ERC20, functionName: 'balanceOf', args: [A.account.address] }),
    B: await pub.readContract({ address: WETH, abi: ERC20, functionName: 'balanceOf', args: [B.account.address] }),
  }
  console.log(`
A got back ${formatEther(after.A - before.A)} WETH`)
  console.log(`B got back ${formatEther(after.B - before.B)} WETH`)
  console.log(`stake was  ${formatEther(m[2])} a side - both sides whole, nobody won`)
}

// ── MAIN ───────────────────────────────────────────────────
const phase = process.env.PHASE
const markets = await preflight()

if (!phase) {
  console.log('\npreflight only. Set PHASE=fund | market | pvp to act.')
} else if (phase === 'fund') {
  await fund()
} else if (phase === 'grace') {
  await grace()
} else if (phase === 'refund') {
  await refund()
} else if (phase === 'unpause') {
  await unpause()
} else if (phase === 'market') {
  await createMarkets()
} else if (phase === 'batch') {
  const market = (process.env.MARKET as Address) ?? markets[0]
  if (!market) throw new Error('no market on this pool; run PHASE=market first')
  await batch(market)
} else if (phase === 'pvp') {
  const market = (process.env.MARKET as Address) ?? markets[0]
  if (!market) throw new Error('no market on this pool; run PHASE=market first')
  await pvp(market)
} else {
  throw new Error(`unknown PHASE ${phase}`)
}
