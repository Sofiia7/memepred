/**
 * End-to-end check of a Robinhood Chain testnet deployment, straight against the
 * contracts, with two funded wallets and the stand-in pools' controllable price.
 *
 *   scripts/node_modules/.bin/tsx scripts/rhc/e2e-verify.mts
 *
 * It signs real transactions on chain 46630 and spends a little testnet gas, so it
 * is opt-in. Config comes from the environment (a repo-root .env supplies the two
 * wallet keys; nothing is ever printed except public hashes and amounts):
 *
 *   RHC_RESOLVER, RHC_LP, RHC_WETH            deployment addresses
 *   RHC_MARKET_LP60  a 60 s market on a pool whose vault access is enabled
 *   RHC_MARKET_PVP   a market on a pool that is NOT authorised on the vault (5 min ok)
 *   RHC_POOL_LP60, RHC_POOL_PVP               the stand-in pool behind each market
 *
 * Scenarios, in the order they run (the slow PvP one starts first and settles last):
 *   P  PvP on an unauthorised market: half-filled order, cancelOrder refunds the
 *      unmatched half at once, the DOWN side wins, the loser has nothing to claim.
 *   W  Vault-backed win on the 60 s market: LP match, price steps up, settle, claim.
 *   R  Consistency guard trips at the end of the window: the resolver refunds BOTH
 *      sides on its first call (audit L02) instead of leaving the match locked.
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
function loadEnvFile(path: string) {
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return }
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
const M_LP60 = need('RHC_MARKET_LP60') as Address
const M_PVP = need('RHC_MARKET_PVP') as Address
const P_LP60 = need('RHC_POOL_LP60') as Address
const P_PVP = need('RHC_POOL_PVP') as Address
const LP = need('RHC_LP') as Address

const key = (k: string) => { const v = need(k); return (v.startsWith('0x') ? v : `0x${v}`) as Hex }
const mk = (name: string, k: string) => {
  const account = privateKeyToAccount(key(k))
  return { name, account, wallet: createWalletClient({ account, chain, transport: http(RPC) }) }
}
const A = mk('A', 'PRIVATE_KEY')
const B = mk('B', 'KEEPER_PRIVATE_KEY')

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function mint(address,uint256)',
])
const MARKET = parseAbi([
  'function placeBet(uint8 dir,uint256 amount,address referrer,uint256 expectedPrice,uint256 slippageBps) returns (uint256)',
  'function claim(uint256 orderId)',
  'function cancelOrder(uint256 orderId)',
  'function emergencyRefundMatch(uint256 matchId)',
  'function feedId() view returns (bytes32)',
  'function getMatch(uint256) view returns ((uint256 upOrderId,uint256 downOrderId,uint256 amount,uint256 entryPrice,uint256 settleAt,uint256 exitPrice,bool settled,bool upWon,bool lpMatch))',
  'function getOrder(uint256) view returns ((address trader,uint8 direction,uint256 amount,uint256 filledAmount,address referrer,uint8 status,uint256 placedAt,uint256 matchId,uint256 pendingSettlements,uint256 payout,bool unmatchedRefunded,uint256 expectedPrice,uint256 slippageBps))',
  'event OrderPlaced(uint256 indexed orderId,address indexed trader,uint8 dir,uint256 amount)',
  'event OrderMatched(uint256 indexed matchId,uint256 upId,uint256 downId,uint256 amount,uint256 entryPrice)',
  'event LPMatched(uint256 indexed matchId,uint256 orderId,uint256 amount,uint256 entryPrice)',
  'event OrderRefunded(uint256 indexed orderId,address trader,uint256 amount)',
  'event MatchSettled(uint256 indexed matchId,bool upWon,uint256 entry,uint256 exit)',
  'event MatchRefunded(uint256 indexed matchId)',
  'event Claimed(uint256 indexed orderId,address trader,uint256 payout)',
])
const RESOLVER_ABI = parseAbi([
  'function spotPriceWad(bytes32) view returns (uint256)',
  'function resolveOrderbookMarketBatch(address,uint256) returns (uint256)',
  'event MatchUnpriceableRefunded(address indexed market,uint256 indexed matchId,uint8 reason)',
  'event MarketResolved(address indexed market,bool upWon,uint256 entry,uint256 exit)',
])
const POOL = parseAbi([
  'function pushTick(uint32 startTs,int24 tick)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
])
const POOL_META = parseAbi(['function token0() view returns (address)'])
const LPABI = parseAbi(['function totalAssets() view returns (uint256)', 'function totalExposure() view returns (uint256)'])

const UP = 0, DOWN = 1
const BET = parseEther('0.01')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const results: Array<{ scenario: string; step: string; tx?: string; note: string }> = []
let failures = 0
const say = (s: string, step: string, note: string, tx?: string) => {
  results.push({ scenario: s, step, note, tx })
  console.log(`[${s}] ${step}${tx ? ` ${tx}` : ''} - ${note}`)
}
const check = (ok: boolean, s: string, what: string) => {
  if (!ok) { failures++; console.log(`[${s}] CHECK FAILED: ${what}`) } else console.log(`[${s}] ok: ${what}`)
}

async function send(w: typeof A, address: Address, abi: any, functionName: string, args: any[]) {
  const { request } = await pub.simulateContract({ account: w.account, address, abi, functionName, args } as any)
  const hash = await w.wallet.writeContract(request as any)
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`)
  return { hash, receipt }
}
async function chainNow() { return Number((await pub.getBlock()).timestamp) }
async function waitUntil(ts: number, label: string) {
  for (;;) {
    const now = await chainNow()
    if (now >= ts) return
    process.stdout.write(`   waiting ${label}: ${ts - now}s\r`)
    await sleep(Math.min(8000, Math.max(1500, (ts - now) * 500)))
  }
}
async function weth(a: Address) { return (await pub.readContract({ address: WETH, abi: ERC20, functionName: 'balanceOf', args: [a] })) as bigint }
async function tick(pool: Address) { return (await pub.readContract({ address: pool, abi: POOL, functionName: 'slot0' }))[1] as number }
async function pushTick(who: typeof A, pool: Address, ts: number, t: number) {
  return send(who, pool, POOL, 'pushTick', [ts, t])
}
/**
 * Which way a tick move pushes the token's price in WETH. The pool's tick is token1 per token0,
 * so when WETH is token0 the token's price in WETH is the reciprocal and a higher tick is a
 * LOWER price. The stand-in pools order their tokens by address, exactly like the real ones.
 */
async function dirSign(pool: Address) {
  const t0 = (await pub.readContract({ address: pool, abi: POOL_META, functionName: 'token0' })) as Address
  return t0.toLowerCase() === WETH.toLowerCase() ? -1 : 1
}
async function price(market: Address) {
  const feed = (await pub.readContract({ address: market, abi: MARKET, functionName: 'feedId' })) as Hex
  return (await pub.readContract({ address: RESOLVER, abi: RESOLVER_ABI, functionName: 'spotPriceWad', args: [feed] })) as bigint
}
async function bet(w: typeof A, market: Address, dir: number, amount: bigint) {
  const p = await price(market)
  const { hash, receipt } = await send(w, market, MARKET, 'placeBet', [dir, amount, '0x0000000000000000000000000000000000000000', p, 100n])
  const placed = parseEventLogs({ abi: MARKET, logs: receipt.logs, eventName: 'OrderPlaced' })[0]
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber })
  return { hash, receipt, orderId: placed.args.orderId as bigint, blockTs: Number(block.timestamp) }
}
async function matchOf(market: Address, id: bigint) {
  return (await pub.readContract({ address: market, abi: MARKET, functionName: 'getMatch', args: [id] })) as any
}
async function orderOf(market: Address, id: bigint) {
  return (await pub.readContract({ address: market, abi: MARKET, functionName: 'getOrder', args: [id] })) as any
}
async function resolveBatch(who: typeof A, market: Address) {
  return send(who, RESOLVER, RESOLVER_ABI, 'resolveOrderbookMarketBatch', [market, 10n])
}

async function main() {
  console.log(`A ${A.account.address}  B ${B.account.address}`)
  console.log(`ETH: A ${formatEther(await pub.getBalance({ address: A.account.address }))}  B ${formatEther(await pub.getBalance({ address: B.account.address }))}`)

  // Stand-in WETH is freely mintable; top both wallets up and approve both markets.
  for (const w of [A, B]) {
    const have = await weth(w.account.address)
    if (have < parseEther('0.2')) await send(w, WETH, ERC20, 'mint', [w.account.address, parseEther('0.3')])
    for (const m of [M_LP60, M_PVP]) {
      await send(w, WETH, ERC20, 'approve', [m, 2n ** 255n])
    }
  }
  const lpBefore = (await pub.readContract({ address: LP, abi: LPABI, functionName: 'totalAssets' })) as bigint

  // ── P: PvP + partial fill + cancelOrder (starts first, settles last) ──
  const P = 'P'
  const aBal0 = await weth(A.account.address)
  const pA = await bet(A, M_PVP, UP, BET * 2n)
  say(P, 'A places UP 0.02 (rests: vault has no access here)', `order ${pA.orderId}`, pA.hash)
  const pB = await bet(B, M_PVP, DOWN, BET)
  const pMatchId = (await orderOf(M_PVP, pA.orderId)).matchId as bigint
  const pm = await matchOf(M_PVP, pMatchId)
  say(P, 'B places DOWN 0.01 and fills half of A', `match ${pMatchId}, lpMatch=${pm.lpMatch}`, pB.hash)
  check(pm.lpMatch === false && pm.amount === BET, P, 'matched peer to peer for 0.01, not by the vault')
  const oBefore = await orderOf(M_PVP, pA.orderId)
  check(oBefore.filledAmount === BET && oBefore.unmatchedRefunded === false, P, 'A is half filled with an open remainder')
  const balBeforeCancel = await weth(A.account.address)
  const c = await send(A, M_PVP, MARKET, 'cancelOrder', [pA.orderId])
  const balAfterCancel = await weth(A.account.address)
  say(P, 'A cancels the remainder', `refunded ${formatEther(balAfterCancel - balBeforeCancel)} WETH at once`, c.hash)
  check(balAfterCancel - balBeforeCancel === BET, P, 'cancelOrder returned exactly the unmatched 0.01 immediately')
  check((await orderOf(M_PVP, pA.orderId)).unmatchedRefunded === true, P, 'order marked unmatchedRefunded')
  // the price falls right after the entry, so DOWN (B) wins
  const pT = await chainNow()
  const pTick = await tick(P_PVP)
  const pSign = await dirSign(P_PVP)
  const pPush = await pushTick(A, P_PVP, pT + 5, pTick - pSign * 200)
  say(P, 'price pushed down 2%', `tick ${pTick} -> ${pTick - pSign * 200}`, pPush.hash)
  const pSettleAt = Number(pm.settleAt)

  // ── W: vault-backed win on the 60 s market ──
  const W = 'W'
  const wBal0 = await weth(A.account.address)
  void wBal0
  const wBet = await bet(A, M_LP60, UP, BET)
  const wOrder = await orderOf(M_LP60, wBet.orderId)
  const wm = await matchOf(M_LP60, wOrder.matchId)
  say(W, 'A places UP 0.01 on the vault-enabled market', `match ${wOrder.matchId}, lpMatch=${wm.lpMatch}`, wBet.hash)
  check(wm.lpMatch === true, W, 'matched by the vault at once')
  const exposure = (await pub.readContract({ address: LP, abi: LPABI, functionName: 'totalExposure' })) as bigint
  check(exposure >= BET, W, `vault exposure is open (${formatEther(exposure)} WETH)`)
  const wTick = await tick(P_LP60)
  const lpSign = await dirSign(P_LP60)
  const wPush = await pushTick(A, P_LP60, wBet.blockTs + 5, wTick + lpSign * 200)
  say(W, 'price pushed up 2%', `tick ${wTick} -> ${wTick + lpSign * 200}`, wPush.hash)
  await waitUntil(Number(wm.settleAt) + 2, 'W settle')
  const wRes = await resolveBatch(A, M_LP60)
  const settled = parseEventLogs({ abi: MARKET, logs: wRes.receipt.logs, eventName: 'MatchSettled' })[0]
  say(W, 'anyone calls the resolver', `MatchSettled upWon=${settled?.args.upWon}`, wRes.hash)
  check(settled?.args.upWon === true, W, 'UP won')
  const wClaim = await send(A, M_LP60, MARKET, 'claim', [wBet.orderId])
  // From the Claimed event, not from A's balance: in this deployment A is also the fee treasury,
  // so the protocol fee of this very match lands back in A's balance.
  const wPaid = parseEventLogs({ abi: MARKET, logs: wClaim.receipt.logs, eventName: 'Claimed' })[0].args.payout as bigint
  say(W, 'A claims', `payout ${formatEther(wPaid)} WETH (pot 0.02 less 1% protocol and 1% vault fee)`, wClaim.hash)
  check(wPaid === parseEther('0.0196'), W, 'payout is exactly 0.0196 WETH')
  check(((await pub.readContract({ address: LP, abi: LPABI, functionName: 'totalExposure' })) as bigint) < exposure, W, 'vault exposure released')

  // ── R: guard trips at the end of the window, both sides refunded at once ──
  const R = 'R'
  const rBal0 = await weth(A.account.address)
  const rBet = await bet(A, M_LP60, UP, BET)
  const rOrder = await orderOf(M_LP60, rBet.orderId)
  const rm = await matchOf(M_LP60, rOrder.matchId)
  const rTick = await tick(P_LP60)
  // last 10 s of a 30 s window jump about 4%: window mean moves ~1.3%, anchor ~4%: spread beyond 2%
  const rPush = await pushTick(A, P_LP60, Number(rm.settleAt) - 10, rTick + lpSign * 400)
  say(R, 'A bets, then the price jumps 4% inside the last 10 s of the window', `match ${rOrder.matchId}`, rBet.hash)
  say(R, 'jump recorded', `tick ${rTick} -> ${rTick + lpSign * 400}`, rPush.hash)
  await waitUntil(Number(rm.settleAt) + 2, 'R settle')
  const rRes = await resolveBatch(A, M_LP60)
  const refundEvt = parseEventLogs({ abi: RESOLVER_ABI, logs: rRes.receipt.logs, eventName: 'MatchUnpriceableRefunded' })[0]
  say(R, 'resolver, first call after settleAt', `MatchUnpriceableRefunded reason=${refundEvt?.args.reason}`, rRes.hash)
  check(refundEvt?.args.reason === 2, R, 'refunded with reason 2 (consistency guard)')
  check((await weth(A.account.address)) === rBal0, R, 'A has exactly the stake back, no fee')
  check((await matchOf(M_LP60, rOrder.matchId)).settled === true, R, 'match is closed on chain')
  let replay = 'reverted as expected'
  try { await pub.simulateContract({ account: A.account, address: M_LP60, abi: MARKET, functionName: 'emergencyRefundMatch', args: [rOrder.matchId] }); replay = 'DID NOT REVERT' } catch { /* expected */ }
  check(replay === 'reverted as expected', R, 'emergencyRefundMatch on the closed match reverts')
  // put the price back so the demo pool is usable again
  await pushTick(A, P_LP60, await chainNow() + 1, rTick)

  // ── P settles last ──
  await waitUntil(pSettleAt + 2, 'P settle')
  const pRes = await resolveBatch(A, M_PVP)
  const pSettled = parseEventLogs({ abi: MARKET, logs: pRes.receipt.logs, eventName: 'MatchSettled' })[0]
  say(P, 'anyone calls the resolver', `MatchSettled upWon=${pSettled?.args.upWon}`, pRes.hash)
  check(pSettled?.args.upWon === false, P, 'DOWN won')
  const pClaim = await send(B, M_PVP, MARKET, 'claim', [pB.orderId])
  const bGot = parseEventLogs({ abi: MARKET, logs: pClaim.receipt.logs, eventName: 'Claimed' })[0].args.payout as bigint
  say(P, 'B claims', `payout ${formatEther(bGot)} WETH (pot 0.02 less 1% protocol fee)`, pClaim.hash)
  check(bGot === parseEther('0.0198'), P, 'payout is exactly 0.0198 WETH')
  let aClaim = 'reverted as expected'
  try { await pub.simulateContract({ account: A.account, address: M_PVP, abi: MARKET, functionName: 'claim', args: [pA.orderId] }); aClaim = 'DID NOT REVERT' } catch { /* expected */ }
  check(aClaim === 'reverted as expected', P, 'the losing side has nothing to claim')

  const lpAfter = (await pub.readContract({ address: LP, abi: LPABI, functionName: 'totalAssets' })) as bigint
  console.log(`\nvault totalAssets ${formatEther(lpBefore)} -> ${formatEther(lpAfter)} WETH`)
  console.log(JSON.stringify(results, null, 2))
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(2) })
