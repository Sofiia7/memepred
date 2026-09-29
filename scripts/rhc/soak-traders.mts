/**
 * Scripted testnet traffic for the Robinhood Chain demo and its soak run: once per cycle a burst of
 * small bets from a few throwaway wallets on every live market, ONE price step per pool right
 * after them so the bets have a winner, then claims for the winners and a running report.
 *
 *   scripts/node_modules/.bin/tsx scripts/rhc/soak-traders.mts [--dry]
 *
 * THIS IS NOT USER ACTIVITY. Every trade is placed by this script with mintable testnet WETH from
 * wallets whose keys sit in scripts/rhc/.soak-wallets.json (ignored by git). Never present the
 * volume it makes as traction; it is there so the demo has something to show and the keeper has
 * real work.
 *
 * WHY THE PRICE STEPS ARE RATIONED. The testnet pools are stand-ins (MockUniswapV3Pool) that keep
 * every price step forever and re-read all of them on every observe(). Each pushTick therefore adds
 * about 8.4 thousand gas to every bet and every settlement on that pool, permanently: a price mover
 * that ticks every 45 seconds took a settlement from 290 to 530 thousand gas in 14 minutes and
 * would have reached 14 million in a day (docs/rhc/ECONOMICS.md, "Найденный дефект"). A real
 * Uniswap pool does not do this. So this script bets in bursts and pushes once per pool per burst,
 * never more than SOAK_MAX_PUSHES in total. Nobody else pushes, or no bet ever wins: with a still
 * price every match ends in a tie and is simply refunded.
 *
 * Anyone can call pushTick on a stand-in pool, so no owner key is needed; the wallet PRIVATE_KEY in
 * a repo-root .env only funds the throwaway wallets with gas. The keeper's and the badge minter's
 * wallets are run by the server, so this script never uses them (two processes sending from one
 * account collide on nonces).
 *
 * Env:
 *   RHC_API           default https://api-rhc.flipthememe.com (markets and deployment addresses come from it)
 *   RHC_RPC_URL       default the public testnet RPC
 *   SOAK_HOURS        how long to keep starting bursts, default 24; it then waits for open orders to close
 *   SOAK_CYCLE_MIN    minutes between bursts, default 60 (each burst places 1-2 bets per market)
 *   SOAK_MAX_PUSHES   hard cap on price steps over the whole run, default 150 (0 = never push)
 *   SOAK_WALLETS      throwaway wallets, default 3
 *   SOAK_FUND_ETH     gas sent to a wallet holding under half of it, default 0.0015
 *   --dry             print what it found and would do, send nothing
 *
 * On restart it reads each wallet's recent orders from the API and claims what is still unclaimed,
 * then carries on, so a reboot does not strand winnings.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  createPublicClient, createWalletClient, http, parseAbi, parseEventLogs, formatEther, parseEther,
  defineChain, type Address, type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

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
const API = process.env.RHC_API ?? 'https://api-rhc.flipthememe.com'
const HOURS = Number(process.env.SOAK_HOURS ?? '24')
const CYCLE_MIN = Number(process.env.SOAK_CYCLE_MIN ?? '60')
const MAX_PUSHES = Number(process.env.SOAK_MAX_PUSHES ?? '150')
const WALLET_COUNT = Number(process.env.SOAK_WALLETS ?? '3')
const FUND = parseEther(process.env.SOAK_FUND_ETH ?? '0.0015')
const DRY = process.argv.includes('--dry')
const WALLET_FILE = process.env.SOAK_WALLETS_FILE ?? resolve(here, '.soak-wallets.json')
const LOG_FILE = resolve(here, 'soak.log')

const chain = defineChain({
  id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})
const pub = createPublicClient({ chain, transport: http(RPC) })

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function mint(address,uint256)',
])
const MARKET = parseAbi([
  'function placeBet(uint8 dir,uint256 amount,address referrer,uint256 expectedPrice,uint256 slippageBps) returns (uint256)',
  'function claim(uint256 orderId)',
  'function feedId() view returns (bytes32)',
  'function MIN_BET() view returns (uint256)',
  'function MAX_BET() view returns (uint256)',
  'function getMatch(uint256) view returns ((uint256 upOrderId,uint256 downOrderId,uint256 amount,uint256 entryPrice,uint256 settleAt,uint256 exitPrice,bool settled,bool upWon,bool lpMatch))',
  'function getOrder(uint256) view returns ((address trader,uint8 direction,uint256 amount,uint256 filledAmount,address referrer,uint8 status,uint256 placedAt,uint256 matchId,uint256 pendingSettlements,uint256 payout,bool unmatchedRefunded,uint256 expectedPrice,uint256 slippageBps))',
  'event OrderPlaced(uint256 indexed orderId,address indexed trader,uint8 dir,uint256 amount)',
])
const RESOLVER_ABI = parseAbi(['function spotPriceWad(bytes32) view returns (uint256)'])
const LP_ABI = parseAbi(['function isAuthorizedMarket(address) view returns (bool)', 'function totalAssets() view returns (uint256)'])
const POOL = parseAbi([
  'function pushTick(uint32 startTs,int24 tick)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
])

const ZERO = '0x0000000000000000000000000000000000000000' as Address
const UP = 0
const DOWN = 1
// Order.status as the contract numbers it.
const PENDING = 0, MATCHED = 1, SETTLED = 2, CLAIMED = 3, REFUNDED = 4
const API_STATUS: Record<string, number> = { PENDING, MATCHED, SETTLED, CLAIMED, REFUNDED }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rand = (n: number) => Math.floor(Math.random() * n)
const pick = <T,>(xs: readonly T[]): T => xs[rand(xs.length)]
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
function log(line: string) {
  const out = `[${stamp()}] ${line}`
  console.log(out)
  try { appendFileSync(LOG_FILE, out + '\n') } catch { /* the console line is enough */ }
}
const oneLine = (e: unknown) => String((e as any)?.shortMessage ?? (e as any)?.message ?? e).split('\n')[0].slice(0, 140)

// ── Discovery: addresses and markets come from the API, never from a possibly stale .env ──────
async function api<T>(path: string): Promise<T> {
  const r = await fetch(API + path)
  if (!r.ok) throw new Error(`${path} answered ${r.status}`)
  return (await r.json()) as T
}
interface Deployment { chainId: number; resolver: Address; liquidityPool: Address; stakeToken: Address }
interface Mkt { address: Address; feedId: Hex; pool: Address; symbol: string; duration: number; vault: boolean; min: bigint; max: bigint }

// ── Wallets ────────────────────────────────────────────────────────────────────────────────────
type W = { name: string; account: ReturnType<typeof privateKeyToAccount>; wallet: ReturnType<typeof createWalletClient> }
function loadWallets(): W[] {
  let keys: Hex[] = []
  if (existsSync(WALLET_FILE)) keys = JSON.parse(readFileSync(WALLET_FILE, 'utf8')).keys ?? []
  const fresh = keys.length < WALLET_COUNT
  while (keys.length < WALLET_COUNT) keys.push(generatePrivateKey())
  if (fresh && !DRY) writeFileSync(WALLET_FILE, JSON.stringify({ keys }, null, 2))
  if (fresh && DRY) console.log('   (dry run: these throwaway wallets are not saved, a real run creates new ones)')
  return keys.slice(0, WALLET_COUNT).map((k, i) => {
    const account = privateKeyToAccount(k)
    return { name: `T${i + 1}`, account, wallet: createWalletClient({ account, chain, transport: http(RPC) }) }
  })
}

async function send(w: W, address: Address, abi: any, functionName: string, args: any[]) {
  const { request } = await pub.simulateContract({ account: w.account, address, abi, functionName, args } as any)
  const hash = await w.wallet.writeContract(request as any)
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`)
  return { hash, receipt }
}

// ── State ──────────────────────────────────────────────────────────────────────────────────────
interface Tracked {
  w: W
  market: Mkt
  orderId: bigint
  amount: bigint
  placedAt: number
  matchId?: bigint
  settleAt?: number
  lp?: boolean
  seenSettled?: boolean
  done?: string
}
const tracked: Tracked[] = []
const counts = { placed: 0, skipped: 0, claims: 0, pushes: 0 }
const skipReasons = new Map<string, number>()
const lags: number[] = []
const closed = new Map<string, number>()

const percentile = (xs: number[], p: number) => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

async function chainNow() { return Number((await pub.getBlock()).timestamp) }
const orderOf = async (m: Address, id: bigint) =>
  (await pub.readContract({ address: m, abi: MARKET, functionName: 'getOrder', args: [id] })) as any
const matchOf = async (m: Address, id: bigint) =>
  (await pub.readContract({ address: m, abi: MARKET, functionName: 'getMatch', args: [id] })) as any

async function placeTracked(dep: Deployment, w: W, m: Mkt, dir: number, amount: bigint) {
  try {
    const spot = (await pub.readContract({ address: dep.resolver, abi: RESOLVER_ABI, functionName: 'spotPriceWad', args: [m.feedId] })) as bigint
    const { receipt } = await send(w, m.address, MARKET, 'placeBet', [dir, amount, ZERO, spot, 100n])
    const placed = parseEventLogs({ abi: MARKET, logs: receipt.logs, eventName: 'OrderPlaced' })[0]
    const block = await pub.getBlock({ blockNumber: receipt.blockNumber })
    tracked.push({ w, market: m, orderId: placed.args.orderId as bigint, amount, placedAt: Number(block.timestamp) })
    counts.placed++
    log(`${w.name} ${dir === UP ? 'UP  ' : 'DOWN'} ${formatEther(amount)} on ${m.symbol} ${m.duration}s -> order ${placed.args.orderId}`)
    return true
  } catch (e) {
    counts.skipped++
    const why = oneLine(e).slice(0, 70)
    skipReasons.set(why, (skipReasons.get(why) ?? 0) + 1)
    log(`${w.name} bet on ${m.symbol} ${m.duration}s skipped: ${why}`)
    return false
  }
}

const AMOUNTS = ['0.005', '0.0075', '0.01', '0.0125', '0.015', '0.02'].map((s) => parseEther(s))
const amountFor = (m: Mkt) => {
  const ok = AMOUNTS.filter((a) => a >= m.min && a <= m.max)
  return ok.length ? pick(ok) : m.min
}

/** One or two bets on every market. The 60 s market goes last so the price step lands just after it. */
async function betBurst(dep: Deployment, ws: W[], markets: Mkt[]) {
  const ordered = [...markets].sort((a, b) => b.duration - a.duration)
  log(`burst: ${ordered.length} markets, 1-2 bets each`)
  for (const m of ordered) {
    for (let i = 0, n = 1 + rand(2); i < n; i++) {
      const amount = amountFor(m)
      if (m.vault) {
        await placeTracked(dep, pick(ws), m, rand(2) === 0 ? UP : DOWN, amount)
      } else {
        // No vault behind this market: it needs a peer, so two wallets take opposite sides at once.
        const a = pick(ws)
        const b = pick(ws.filter((x) => x !== a))
        const dir = rand(2) === 0 ? UP : DOWN
        if (await placeTracked(dep, a, m, dir, amount)) await placeTracked(dep, b, m, dir === UP ? DOWN : UP, amount)
      }
    }
  }
}

/** One price step per pool, a mean-reverting walk like price-mover.mts, but never a step under 15 ticks: a step that small could tie. */
async function pushRound(ws: W[], pools: Address[]) {
  const LIMIT = 500
  const STEP = 40
  for (const pool of pools) {
    if (counts.pushes >= MAX_PUSHES) return
    try {
      const tick = Number((await pub.readContract({ address: pool, abi: POOL, functionName: 'slot0' }))[1])
      const pull = Math.max(-1, Math.min(1, tick / LIMIT))
      const r = Math.random() * 2 - 1 - pull * 0.6
      let delta = Math.round(Math.max(-1, Math.min(1, r)) * STEP)
      if (Math.abs(delta) < 15) delta = delta >= 0 ? 15 : -15
      const next = Math.max(-LIMIT * 2, Math.min(LIMIT * 2, tick + delta))
      const ts = (await chainNow()) + 1
      await send(pick(ws), pool, POOL, 'pushTick', [ts, next])
      counts.pushes++
      log(`price step on ${pool.slice(0, 10)}...: tick ${tick} -> ${next} (${counts.pushes}/${MAX_PUSHES} steps used)`)
    } catch (e) {
      log(`price step on ${pool.slice(0, 10)}... failed: ${oneLine(e)}`)
    }
  }
}

// ── Follow every order to its end: claim the winners, time the keeper ─────────────────────────
async function housekeeping() {
  const now = await chainNow()
  for (const t of tracked) {
    if (t.done) continue
    try {
      const o = await orderOf(t.market.address, t.orderId)
      if (o.matchId !== 0n && t.matchId === undefined) {
        t.matchId = o.matchId
        const m0 = await matchOf(t.market.address, o.matchId)
        t.settleAt = Number(m0.settleAt)
        t.lp = m0.lpMatch
      }
      if (t.matchId !== undefined && t.settleAt !== undefined && !t.seenSettled) {
        const m1 = await matchOf(t.market.address, t.matchId)
        if (m1.settled) { t.seenSettled = true; lags.push(Math.max(0, now - t.settleAt)) }
      }
      const status = Number(o.status)
      if ((status === SETTLED || status === REFUNDED) && o.payout > 0n) {
        try {
          await send(t.w, t.market.address, MARKET, 'claim', [t.orderId])
          counts.claims++
          log(`${t.w.name} claimed ${formatEther(o.payout)} on order ${t.orderId} (${t.market.symbol} ${t.market.duration}s)`)
        } catch (e) {
          log(`${t.w.name} claim of order ${t.orderId} not possible yet: ${oneLine(e).slice(0, 70)}`)
        }
      } else if (status === CLAIMED) {
        t.done = 'claimed'
      } else if (status === SETTLED) {
        t.done = 'lost or tied'
      } else if (status === REFUNDED) {
        t.done = 'refunded'
      } else if (status === PENDING && now - t.placedAt > 20 * 60) {
        t.done = 'stuck unmatched'
      }
      if (t.done) closed.set(t.done, (closed.get(t.done) ?? 0) + 1)
    } catch (e) {
      log(`follow-up of order ${t.orderId} failed: ${oneLine(e)}`)
    }
  }
}

/** After a restart: pick up each wallet's recent orders from the API and finish what is unfinished. */
async function resume(ws: W[], markets: Mkt[]) {
  let picked = 0
  for (const w of ws) {
    try {
      const profile = await api<any>(`/api/profile/${w.account.address}`)
      for (const row of profile.recentOrders ?? []) {
        const market = markets.find((m) => m.address.toLowerCase() === String(row.market_address).toLowerCase())
        if (!market) continue
        const status = API_STATUS[String(row.status)]
        if (status === CLAIMED || (status === SETTLED && !(Number(row.payout_usdc) > 0)) || (status === REFUNDED && !(Number(row.payout_usdc) > 0))) continue
        tracked.push({ w, market, orderId: BigInt(row.order_id), amount: parseEther(String(row.amount_usdc)), placedAt: Math.floor(new Date(row.placed_at).getTime() / 1000) })
        picked++
      }
    } catch (e) {
      log(`could not read ${w.name}'s orders from the API: ${oneLine(e)}`)
    }
  }
  if (picked) log(`resumed ${picked} unfinished order(s) from an earlier run`)
}

async function report(ws: W[]) {
  const open = tracked.filter((t) => !t.done).length
  const matched = tracked.filter((t) => t.matchId !== undefined)
  const vault = matched.filter((t) => t.lp).length
  let minEth = Infinity
  for (const w of ws) minEth = Math.min(minEth, Number(formatEther(await pub.getBalance({ address: w.account.address }))))
  let deep = '?'
  try { deep = ((await (await fetch(`${API}/health/deep`)).json()) as any).status } catch { deep = 'unreachable' }
  const closedText = [...closed.entries()].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'
  const reasons = [...skipReasons.entries()].map(([k, v]) => `${v}x ${k}`).join('; ')
  log(
    `REPORT placed ${counts.placed}, skipped ${counts.skipped} | matched ${matched.length} (vault ${vault}, peer ${matched.length - vault}) ` +
    `| closed: ${closedText} | open ${open} | claims ${counts.claims} | price steps ${counts.pushes}/${MAX_PUSHES} ` +
    `| seen settled after due (upper bound, polled every 30 s; keeper-lag.mts is exact) p50 ${percentile(lags, 50)}s p95 ${percentile(lags, 95)}s (n=${lags.length}) ` +
    `| lowest wallet ETH ${minEth.toFixed(5)} | api deep ${deep}` + (reasons ? ` | skips: ${reasons}` : ''),
  )
}

async function main() {
  if ((await pub.getChainId()) !== 46630) throw new Error('this script only runs on Robinhood Chain testnet (46630)')
  const dep = await api<Deployment>('/api/deployment')
  if (dep.chainId !== 46630) throw new Error(`the API says chain ${dep.chainId}, not 46630`)
  const list = await api<any>('/api/markets')
  const rows: any[] = Array.isArray(list) ? list : list.markets ?? []
  const markets: Mkt[] = []
  for (const r of rows) {
    const address = r.address as Address
    const vault = (await pub.readContract({ address: dep.liquidityPool, abi: LP_ABI, functionName: 'isAuthorizedMarket', args: [address] })) as boolean
    const min = (await pub.readContract({ address, abi: MARKET, functionName: 'MIN_BET' })) as bigint
    const max = (await pub.readContract({ address, abi: MARKET, functionName: 'MAX_BET' })) as bigint
    const feedId = r.feedId as Hex
    // The stand-in pool's address is the feed id's low 20 bytes.
    const pool = `0x${feedId.slice(26)}` as Address
    markets.push({ address, feedId, pool, symbol: String(r.feedSymbol ?? r.symbol ?? address.slice(0, 8)), duration: Number(r.duration), vault, min, max })
  }
  const pools = [...new Set(markets.map((m) => m.pool))]
  const vaultAssets = (await pub.readContract({ address: dep.liquidityPool, abi: LP_ABI, functionName: 'totalAssets' })) as bigint
  const ws = loadWallets()

  console.log(`markets (${markets.length}):`)
  for (const m of markets) console.log(`  ${m.address} ${m.symbol} ${m.duration}s  vault ${m.vault ? 'yes' : 'no (peer to peer)'}  bet ${formatEther(m.min)}-${formatEther(m.max)}  pool ${m.pool}`)
  console.log(`vault assets ${formatEther(vaultAssets)} WETH; ${pools.length} pools; at most ${MAX_PUSHES} price steps in total`)
  for (const w of ws) console.log(`  ${w.name} ${w.account.address}  ETH ${formatEther(await pub.getBalance({ address: w.account.address }))}`)
  if (markets.length === 0) throw new Error('no markets to trade on')
  if (markets.some((m) => !m.vault) && ws.length < 2) throw new Error('a market without a vault needs at least two wallets')
  if (DRY) { console.log('dry run, nothing sent'); return }

  // Gas from the funder's wallet, then free testnet WETH and approvals.
  const funderKey = process.env.PRIVATE_KEY
  if (!funderKey) throw new Error('PRIVATE_KEY is required (it only funds the throwaway wallets with gas)')
  const funder = privateKeyToAccount((funderKey.startsWith('0x') ? funderKey : `0x${funderKey}`) as Hex)
  const funderWallet = createWalletClient({ account: funder, chain, transport: http(RPC) })
  for (const w of ws) {
    if ((await pub.getBalance({ address: w.account.address })) < FUND / 2n) {
      const hash = await funderWallet.sendTransaction({ to: w.account.address, value: FUND })
      await pub.waitForTransactionReceipt({ hash })
      log(`${w.name} funded with ${formatEther(FUND)} ETH for gas`)
    }
    const have = (await pub.readContract({ address: dep.stakeToken, abi: ERC20, functionName: 'balanceOf', args: [w.account.address] })) as bigint
    if (have < parseEther('1')) await send(w, dep.stakeToken, ERC20, 'mint', [w.account.address, parseEther('5')])
    for (const m of markets) {
      const al = (await pub.readContract({ address: dep.stakeToken, abi: ERC20, functionName: 'allowance', args: [w.account.address, m.address] })) as bigint
      if (al < 2n ** 200n) await send(w, dep.stakeToken, ERC20, 'approve', [m.address, 2n ** 255n])
    }
  }
  await resume(ws, markets)
  log(`ready: ${ws.length} wallets, ${markets.length} markets, a burst every ${CYCLE_MIN} min for ${HOURS} h, at most ${MAX_PUSHES} price steps`)

  let stop = false
  process.on('SIGINT', () => { stop = true; log('stop requested, finishing open orders') })
  const endAt = Date.now() + HOURS * 3600_000
  let nextCycle = Date.now()
  let nextReport = Date.now() + 10 * 60_000
  while (!stop && Date.now() < endAt) {
    try {
      if (Date.now() >= nextCycle) {
        await betBurst(dep, ws, markets)
        // Let the last match land, then step every pool once so the burst has winners.
        await sleep(8_000)
        if (MAX_PUSHES > 0) await pushRound(ws, pools)
        // A little jitter, so the bursts do not sit on the hour like a cron job.
        nextCycle = Date.now() + CYCLE_MIN * 60_000 * (0.8 + Math.random() * 0.4)
      }
      await housekeeping()
      if (Date.now() >= nextReport) { await report(ws); nextReport = Date.now() + 10 * 60_000 }
    } catch (e) {
      log(`cycle failed, carrying on: ${oneLine(e)}`)
      await sleep(15_000)
    }
    await sleep(30_000)
  }

  log('no more bursts, waiting for the open orders to close (up to 15 minutes)')
  const drainUntil = Date.now() + 15 * 60_000
  while (Date.now() < drainUntil && tracked.some((t) => !t.done)) {
    await housekeeping()
    await sleep(20_000)
  }
  await report(ws)
  log('soak finished')
}

main().catch((e) => { log(`fatal: ${oneLine(e)}`); process.exit(1) })
