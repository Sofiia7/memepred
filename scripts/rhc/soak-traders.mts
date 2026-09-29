/**
 * Scripted testnet traffic for the Robinhood Chain demo and its soak run: small bets from a few
 * throwaway wallets on every live market, winners claim, and a running report of how long the
 * keeper took to settle each match after it was due.
 *
 *   scripts/node_modules/.bin/tsx scripts/rhc/soak-traders.mts [--dry]
 *
 * THIS IS NOT USER ACTIVITY. Every trade is placed by this script with mintable testnet WETH from
 * wallets whose keys sit in scripts/rhc/.soak-wallets.json (ignored by git). Never present the
 * volume it makes as traction; it is there so the demo has something to show and the keeper has
 * real work.
 *
 * Pair it with scripts/rhc/price-mover.mts (a different wallet, the pool owner), which is what
 * makes some bets win and some lose. Do not point both at the same key: two processes sending
 * from one account collide on nonces. The keeper's and the badge minter's wallets are run by the
 * server, so this script never uses them either.
 *
 * Env (a repo-root .env supplies PRIVATE_KEY, which only funds the throwaway wallets with gas):
 *   RHC_API           default https://api-rhc.flipthememe.com (markets and deployment addresses come from it)
 *   RHC_RPC_URL       default the public testnet RPC
 *   SOAK_HOURS        how long to place bets, default 24; it then waits for the open orders to close
 *   SOAK_GAP_SEC      mean seconds between actions, default 110
 *   SOAK_WALLETS      throwaway wallets, default 3
 *   SOAK_FUND_ETH     gas sent to a wallet holding under half of it, default 0.002
 *   SOAK_BURST_PCT    chance an action is a burst of 4 to 6 quick bets on the 60 s market, default 12
 *   --dry             print what it found and would do, send nothing
 *
 * At 0.01 gwei a bet or a claim costs about 0.000003 ETH, so 0.002 ETH a wallet is thousands of them.
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
const GAP = Number(process.env.SOAK_GAP_SEC ?? '110')
const WALLET_COUNT = Number(process.env.SOAK_WALLETS ?? '3')
const FUND = parseEther(process.env.SOAK_FUND_ETH ?? '0.002')
const BURST_PCT = Number(process.env.SOAK_BURST_PCT ?? '12')
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

const ZERO = '0x0000000000000000000000000000000000000000' as Address
const UP = 0
const DOWN = 1
// Order.status as the contract numbers it.
const PENDING = 0, MATCHED = 1, SETTLED = 2, CLAIMED = 3, REFUNDED = 4

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
interface Mkt { address: Address; feedId: Hex; symbol: string; duration: number; vault: boolean; min: bigint; max: bigint }

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
const counts = { placed: 0, skipped: 0, claims: 0, claimFailed: 0 }
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

async function oneBetAction(dep: Deployment, ws: W[], markets: Mkt[], only60?: boolean) {
  const pool = only60 ? markets.filter((m) => m.duration <= 60) : markets
  // The 5 minute markets get more of the traffic than the 60 second one.
  const weighted = pool.flatMap((m) => Array(m.duration <= 60 ? 2 : 3).fill(m) as Mkt[])
  const m = pick(weighted.length ? weighted : markets)
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
          counts.claimFailed++
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
    `| closed: ${closedText} | open ${open} | claims ${counts.claims} | keeper lag after due p50 ${percentile(lags, 50)}s ` +
    `p95 ${percentile(lags, 95)}s max ${lags.length ? Math.max(...lags) : NaN}s (n=${lags.length}) | lowest wallet ETH ${minEth.toFixed(5)} | api deep ${deep}` +
    (reasons ? ` | skips: ${reasons}` : ''),
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
    markets.push({ address, feedId: r.feedId as Hex, symbol: String(r.feedSymbol ?? r.symbol ?? address.slice(0, 8)), duration: Number(r.duration), vault, min, max })
  }
  const vaultAssets = (await pub.readContract({ address: dep.liquidityPool, abi: LP_ABI, functionName: 'totalAssets' })) as bigint
  const ws = loadWallets()

  console.log(`markets (${markets.length}):`)
  for (const m of markets) console.log(`  ${m.address} ${m.symbol} ${m.duration}s  vault ${m.vault ? 'yes' : 'no (peer to peer)'}  bet ${formatEther(m.min)}-${formatEther(m.max)}`)
  console.log(`vault assets ${formatEther(vaultAssets)} WETH`)
  for (const w of ws) console.log(`  ${w.name} ${w.account.address}  ETH ${formatEther(await pub.getBalance({ address: w.account.address }))}`)
  if (markets.length === 0) throw new Error('no markets to trade on')
  if (markets.some((m) => !m.vault) && ws.length < 2) throw new Error('a market without a vault needs at least two wallets')
  if (DRY) { console.log('dry run, nothing sent'); return }

  // Gas from the pool owner's wallet, then free testnet WETH and approvals.
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
  log(`ready: ${ws.length} wallets, ${markets.length} markets, betting for ${HOURS} h, mean gap ${GAP} s`)

  let stop = false
  process.on('SIGINT', () => { stop = true; log('stop requested, finishing open orders') })
  const endAt = Date.now() + HOURS * 3600_000
  let nextReport = Date.now() + 10 * 60_000
  while (!stop && Date.now() < endAt) {
    try {
      if (rand(100) < BURST_PCT) {
        const n = 4 + rand(3)
        log(`burst of ${n} quick bets on the 60 s market`)
        for (let i = 0; i < n; i++) await oneBetAction(dep, ws, markets, true)
      } else {
        await oneBetAction(dep, ws, markets)
      }
      await housekeeping()
      if (Date.now() >= nextReport) { await report(ws); nextReport = Date.now() + 10 * 60_000 }
    } catch (e) {
      log(`cycle failed, carrying on: ${oneLine(e)}`)
      await sleep(15_000)
    }
    // Exponential gaps, so the traffic is bursty the way real traffic is, but never dead or frantic.
    const gap = Math.min(GAP * 3, Math.max(15, -Math.log(1 - Math.random()) * GAP)) * 1000
    await sleep(gap)
  }

  log('no more bets, waiting for the open orders to close (up to 15 minutes)')
  const drainUntil = Date.now() + 15 * 60_000
  while (Date.now() < drainUntil && tracked.some((t) => !t.done)) {
    await housekeeping()
    await sleep(20_000)
  }
  await report(ws)
  log('soak finished')
}

main().catch((e) => { log(`fatal: ${oneLine(e)}`); process.exit(1) })
