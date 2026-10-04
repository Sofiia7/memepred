/**
 * One round, the way a player does it: two throwaway wallets bet UP and DOWN with native ETH (betWithEth,
 * no wrap, no approval), the strike is fixed and the round settled by the deployed keeper, the winner
 * collects as ETH (claimAsEth). About 16 minutes with the 60-second strike window. Prints what happened
 * and when, so the run can be pasted as evidence.
 *
 *   set ROUNDS_ADDRESS=0x...
 *   scripts\node_modules\.bin\tsx scripts\rhc\rounds-play.mts                 read only: wallets, pool, next window
 *   scripts\node_modules\.bin\tsx scripts\rhc\rounds-play.mts --yes-testnet   play it
 *
 * Wallets: the first two keys of scripts/rhc/.soak-wallets.json (p1 bets UP, p2 DOWN); keys never printed.
 * Options: --pool 0x... (default the continuous FROGGO demo pool of 4 October), --stake ETH (default the
 * contract's minStake), --no-push (disable an injected step on legacy controllable stand-ins).
 * ContinuousDemoPool prices move by themselves; this script never forces their winner.
 * Needs the keeper running on ROUNDS_ADDRESS (rounds-keeper-local.mts or the server one). Testnet only.
 */
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseAbi, parseEther, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { artifact, readSoakKeys, TESTNET_ID, TESTNET_RPC } from './rounds-lib.mts'

const argv = process.argv.slice(2)
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
const YES = argv.includes('--yes-testnet')
const PUSH = !argv.includes('--no-push')
const T = 300
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const GAS_RESERVE = 2n * 10n ** 14n
const rounds = (process.env.ROUNDS_ADDRESS ?? '') as Address
if (!/^0x[0-9a-fA-F]{40}$/.test(rounds)) throw new Error('set ROUNDS_ADDRESS=0x... (PoolRounds) first')
const pool = (opt('--pool') ?? '0x9935aef7659f1c30843f0c959c349304f1bccfbe') as Address

const rpcUrl = process.env.RHC_RPC_URL ?? TESTNET_RPC
if (/mainnet/i.test(rpcUrl)) throw new Error(`refusing an RPC that names mainnet: ${rpcUrl}`)
const chain = defineChain({ id: TESTNET_ID, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } })
const pub = createPublicClient({ chain, transport: http(rpcUrl) })
const id = await pub.getChainId()
if (id !== TESTNET_ID) throw new Error(`chain ${id} is not the testnet ${TESTNET_ID}: refusing`)

const R_ABI = artifact('PoolRounds.sol/PoolRounds.json').abi
const POOL_ABI = parseAbi(['function pushTick(uint32 startTs, int24 tick)', 'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)'])
const DEMO_ABI = parseAbi(['function STEP_SECONDS() view returns (uint256)'])
const continuousDemo = await pub.readContract({ address: pool, abi: DEMO_ABI, functionName: 'STEP_SECONDS' }).then((s) => s === 20n).catch(() => false)
const OUT = ['NONE', 'UP', 'DOWN', 'TIE', 'REFUND']
const stamp = () => new Date().toISOString().replace('T', ' ').slice(11, 19)
const say = (m: string) => console.log(`[${stamp()}] ${m}`)
const fmt = (w: bigint) => formatEther(w)
const read = <R = any,>(address: Address, abi: any, functionName: string, args: unknown[] = []) => pub.readContract({ address, abi, functionName, args } as any) as Promise<R>
const now = async () => Number((await pub.getBlock({ blockTag: 'latest' })).timestamp)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitUntil(ts: number, what: string) {
  let t = await now()
  if (t < ts) say(`waiting for ${what}: ${ts - t} s`)
  while (t < ts) { await sleep(Math.min(5_000, Math.max(1_000, (ts - t) * 1000))); t = await now() }
}

const keys = readSoakKeys()
if (keys.length < 2) throw new Error('scripts/rhc/.soak-wallets.json needs at least two keys')
const players = [{ name: 'p1', side: 1, account: privateKeyToAccount(keys[0]) }, { name: 'p2', side: 2, account: privateKeyToAccount(keys[1]) }]
const wallets = players.map((p) => createWalletClient({ account: p.account, chain, transport: http(rpcUrl) }))
async function send(i: number, address: Address, abi: any, functionName: string, args: unknown[] = [], value?: bigint) {
  const hash = await wallets[i].writeContract({ address, abi, functionName, args, chain, account: players[i].account, ...(value !== undefined ? { value } : {}) } as any)
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (r.status !== 'success') throw new Error(`${players[i].name} ${functionName} reverted, tx ${hash}`)
  const b = await pub.getBlock({ blockNumber: r.blockNumber })
  return { r, hash, ts: Number(b.timestamp) }
}
async function eventTs(name: string, roundId: bigint, fromBlock: bigint) {
  const ev = R_ABI.find((i: any) => i.type === 'event' && i.name === name)
  const logs = await pub.getLogs({ address: rounds, event: ev, args: { roundId }, fromBlock, toBlock: 'latest' } as any)
  if (!logs.length) return null
  const l: any = logs[0]
  const b = await pub.getBlock({ blockNumber: l.blockNumber })
  return { ts: Number(b.timestamp), hash: l.transactionHash as Hex, args: l.args }
}

// ── the plan ──
const cfg = await read<any>(rounds, R_ABI, 'pools', [pool])
const listed = Boolean(cfg[0] ?? cfg.listed), wethIsToken0 = Boolean(cfg[1] ?? cfg.wethIsToken0)
if (!listed) throw new Error(`pool ${pool} is not listed on ${rounds}`)
const minStake = await read<bigint>(rounds, R_ABI, 'minStake'), maxStake = await read<bigint>(rounds, R_ABI, 'maxStake'), minBank = await read<bigint>(rounds, R_ABI, 'minBank')
const stake = opt('--stake') ? parseEther(opt('--stake')!) : minStake
if (stake < minStake || stake > maxStake) throw new Error(`stake ${fmt(stake)} is outside ${fmt(minStake)}..${fmt(maxStake)}`)
say(`PoolRounds ${rounds}, pool ${pool} (WETH is token${wethIsToken0 ? 0 : 1}), stake ${fmt(stake)} ETH each side, minBank ${fmt(minBank)}`)
let short = false
for (const p of players) {
  const b = await pub.getBalance({ address: p.account.address })
  say(`${p.name} ${p.account.address}: ${fmt(b)} ETH, bets ${p.side === 1 ? 'UP' : 'DOWN'} (needs ${fmt(stake + GAS_RESERVE)})`)
  if (b < stake + GAS_RESERVE) short = true
}
if (short) throw new Error('a player is short of ETH for its stake plus gas')
if (2n * stake < minBank) throw new Error(`two stakes of ${fmt(stake)} make ${fmt(2n * stake)}, below minBank ${fmt(minBank)}: the round would not play`)
// the window: the current one when at least 60 s of it are left, else the next
let t0 = await now()
let k = Math.floor(t0 / T)
if ((k + 1) * T - t0 < 60) k++
const roundId = await read<bigint>(rounds, R_ABI, 'roundIdOf', [pool, BigInt(T), BigInt(k)])
const times = await read<any>(rounds, R_ABI, 'roundTimes', [roundId])
const tm = { openAt: Number(times.openAt), closeAt: Number(times.closeAt), strikeStart: Number(times.strikeStart), strikeEnd: Number(times.strikeEnd), settleAt: Number(times.settleAt) }
const [fixStrikeBy, settleBy] = (await read<[bigint, bigint]>(rounds, R_ABI, 'keeperDeadlines', [roundId])).map(Number)
const at = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 19)
say(`round ${roundId}: bets ${at(tm.openAt)}-${at(tm.closeAt)}, pause to ${at(tm.strikeStart)}, strike window to ${at(tm.strikeEnd)}, exit and settle at ${at(tm.settleAt)} UTC (result ${Math.round((tm.settleAt - tm.closeAt) / 60)} min after the close)`)
if (!YES) { say('read only. To play: add --yes-testnet'); process.exit(0) }

// ── bets ──
await waitUntil(tm.openAt, 'the window to open')
const startBlock = (await pub.getBlock({ blockTag: 'latest' })).number!
for (const [i, p] of players.entries()) {
  const s = await send(i, rounds, R_ABI, 'betWithEth', [roundId, p.side, ZERO], stake)
  say(`${p.name} bet ${p.side === 1 ? 'UP' : 'DOWN'} ${fmt(stake)} ETH: ${s.ts - tm.openAt} s into the window, gas ${s.r.gasUsed}, tx ${s.hash}`)
}
let v = await read<any>(rounds, R_ABI, 'roundView', [roundId])
say(`book: UP ${fmt(v.rawUp)}, DOWN ${fmt(v.rawDown)}`)

// ── close, strike, one price step, settle ──
await waitUntil(tm.closeAt + 2, 'the close')
v = await read<any>(rounds, R_ABI, 'roundView', [roundId])
say(`closed: activated ${v.activated}, bank ${fmt(v.bank)}`)
if (!v.activated) throw new Error('the round did not activate: both stakes come back in full by claimAsEth')
await waitUntil(tm.strikeEnd, 'the end of the strike window (the keeper fixes the strike now)')
for (;;) {
  v = await read<any>(rounds, R_ABI, 'roundView', [roundId])
  if (v.strikeFixed || Number(v.outcome) !== 0) break
  if ((await now()) > fixStrikeBy) throw new Error(`no fixStrike by the keeper deadline (strikeEnd + ${fixStrikeBy - tm.strikeEnd} s): is the keeper running on ${rounds}?`)
  await sleep(5_000)
}
const sf = await eventTs('StrikeFixed', roundId, startBlock)
say(`strike fixed ${sf ? `${sf.ts - tm.strikeEnd} s after strikeEnd (allowed ${fixStrikeBy - tm.strikeEnd}), tx ${sf.hash}` : 'before the strike window ended (settled early)'}`)
if (PUSH && !continuousDemo && Number(v.outcome) === 0) {
  // UP means the meme token dearer in WETH: a higher tick when WETH is token1, a lower one when it is token0.
  const tick = Number((await read<any>(pool, POOL_ABI, 'slot0'))[1])
  const next = wethIsToken0 ? tick - 200 : tick + 200
  let startTs = tm.strikeEnd
  try { await pub.simulateContract({ account: players[0].account, address: pool, abi: POOL_ABI, functionName: 'pushTick', args: [startTs, next] }) } catch { startTs = (await now()) + 1 }
  const s = await send(0, pool, POOL_ABI, 'pushTick', [startTs, next])
  say(`price step on the stand-in pool: tick ${tick} -> ${next} (UP should win), tx ${s.hash}`)
}
await waitUntil(tm.settleAt, 'settleAt (the keeper settles now)')
for (;;) {
  v = await read<any>(rounds, R_ABI, 'roundView', [roundId])
  if (Number(v.outcome) !== 0) break
  if ((await now()) > settleBy) throw new Error(`no settle by the keeper deadline (settleAt + ${settleBy - tm.settleAt} s): is the keeper running on ${rounds}?`)
  await sleep(5_000)
}
const st = await eventTs('RoundSettled', roundId, startBlock)
say(`settled ${OUT[Number(v.outcome)]}${st ? `, ${st.ts - tm.settleAt} s after settleAt (allowed ${settleBy - tm.settleAt}), tx ${st.hash}` : ''}; entry tick ${v.entryTick}, exit tick ${v.exitTick}`)

// ── collect ──
for (const [i, p] of players.entries()) {
  const [payout] = await read<[bigint, bigint]>(rounds, R_ABI, 'previewClaim', [roundId, p.account.address])
  const before = await pub.getBalance({ address: p.account.address })
  const s = await send(i, rounds, R_ABI, 'claimAsEth', [roundId])
  const after = await pub.getBalance({ address: p.account.address })
  const fee = s.r.gasUsed * s.r.effectiveGasPrice
  say(`${p.name} collected ${fmt(payout)} ETH (${(Number(payout) / Number(stake)).toFixed(2)}x of the stake), balance ${fmt(before)} -> ${fmt(after)}, gas ${fmt(fee)}, tx ${s.hash}`)
}
say(`done: round ${roundId} ${OUT[Number(v.outcome)]}, result ${st ? st.ts - tm.closeAt : '?'} s after the close`)
