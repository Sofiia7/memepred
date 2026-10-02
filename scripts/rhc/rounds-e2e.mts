/**
 * End-to-end check of PoolRounds (interface v3 with the re-audit fixes): deployment, a winner round,
 * a tie, a round with one side only, the keeper's fixStrike and settle, claims, the referral share
 * and the fee withdrawal, with the gas and the time of every step.
 *
 *   scripts\node_modules\.bin\tsx scripts\rhc\rounds-e2e.mts --local [--history 47,31,35] [--anvil-url http://127.0.0.1:8545] [--log FILE]
 *   scripts\node_modules\.bin\tsx scripts\rhc\rounds-e2e.mts --testnet                       plan only, reads, sends nothing
 *   scripts\node_modules\.bin\tsx scripts\rhc\rounds-e2e.mts --testnet --yes-testnet         real transactions on 46630
 *
 * --local  starts its own anvil on 127.0.0.1 (chain id 46630) or uses the one given by --anvil-url
 *          (refused unless it is 127.0.0.1 or localhost and answers as anvil), behind a local proxy
 *          that prices gas as the testnet does: 0.01 gwei base fee in every block and no tip. It
 *          rehearses docs/rhc/ROUNDS-DEPLOY.md:
 *            1. a pool like today's testnet demo pools (MockUniswapV3Pool, 40 WETH, ring 300): the
 *               REAL contracts/script/DeployPoolRounds.s.sol must refuse to list it, and send nothing;
 *            2. new stand-ins as rounds-deploy.mts makes them (rounds-lib.mts deployRoundStandins:
 *               PoolRoundMockPool, the forge tests' mock, with a liquidity history, depth
 *               max(1 000, 20 x gateDepth) WETH, ring = minCardinality,
 *               two hours of history, in a stand-in factory of their own);
 *            3. the old-style pool made to pass the gate (depth and ring raised) and listed next to
 *               them: it must list, and its round must end REFUND (thin), because that mock returns
 *               no secondsPerLiquidity; this is what would happen to the demo pools;
 *            4. the deployment itself (forge script --broadcast, only ever against this anvil; its
 *               broadcast record goes to a temporary folder, not contracts/broadcast), then the cycle.
 *          --history a,b,c stores that many price steps on the three new pools (default 1), to
 *          reproduce what the demo pools cost to read today (the gate check counted 47, 31 and 35).
 *          Every key is generated in this process and funded by anvil_setBalance; none is printed.
 *
 * --testnet  refuses any chain but 46630. Without --yes-testnet it only reads and prints the plan.
 *          With it: players are the first two keys of scripts/rhc/.soak-wallets.json, the referrer the
 *          third (values never printed); the stand-in WETH is minted, or wrapped from each player's own
 *          ETH when the WETH is deposit-backed (TestWETH); ONE price step is pushed on the
 *          winner pool (each step makes a stand-in pool dearer to read for good: DECISIONS.md 21).
 *          Needs ROUNDS_ADDRESS (the deployed PoolRounds) and ROUNDS_START_BLOCK; the pools are
 *          ROUNDS_E2E_POOLS=win,tie,one, or else the first three PoolListed from ROUNDS_START_BLOCK.
 *          Keeper: --keeper external (default) waits for the deployed keeper and fails the run if
 *          fixStrike or settle comes after the contract's keeperDeadlines(roundId); --keeper inline runs
 *          backend/src/rounds in this process with the key of the .env variable named by
 *          --keeper-key-env (default PRIVATE_KEY; KEEPER_PRIVATE_KEY is refused because the server's
 *          keeper sends from it and two processes collide on nonces). Stop scripts/rhc/soak-traders.mts
 *          and price-mover.mts first: they use the same wallets. A run takes about 25 minutes.
 *
 * The keeper is the real code of backend/src/rounds, imported (scripts/rhc/rounds-lib.mts,
 * loadKeeperCode), with the real keeperWallet.sendKeeperTx; only Redis is replaced, by the
 * in-memory store. Exit code 0 only when every check passed.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createTestClient, createWalletClient, defineChain,
  formatGwei, http, parseAbi, parseEventLogs, type Address, type Hex, type PublicClient,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import {
  artifact, asKey, CONTRACTS, fmtEth, foundry, isLocalUrl, loadKeeperCode, readEnvNames, readSoakKeys,
  deployRoundStandins, deployScriptDefault, plannedGate, runDeployScript, standinDepthEth, sleep, startChainLikeProxy, TESTNET_ID, TESTNET_RPC,
} from './rounds-lib.mts'

// ── arguments ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const has = (f: string) => argv.includes(f)
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
const LOCAL = has('--local')
const TESTNET = has('--testnet')
if (LOCAL === TESTNET) {
  console.error('say exactly one of --local or --testnet')
  process.exit(2)
}
const LOG_FILE = opt('--log')
if (LOG_FILE) writeFileSync(LOG_FILE, '')

const ETH = 10n ** 18n
const T = 300
const ZERO = '0x0000000000000000000000000000000000000000' as Address

// ── output ──────────────────────────────────────────────────────────────
function out(line = '') {
  console.log(line)
  if (LOG_FILE) appendFileSync(LOG_FILE, line + '\n')
}
const startedMs = Date.now()
interface Step { what: string; who: string; gas: bigint | null; tx: Hex | null; chainT: number | null; wallMs: number; note: string }
const steps: Step[] = []
const checks: Array<{ ok: boolean; what: string }> = []
function check(ok: boolean, what: string) {
  checks.push({ ok, what })
  out(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
}
let openAtForSteps = 0
function record(s: Omit<Step, 'wallMs' | 'chainT'> & { chainTs?: number | null; wallMs?: number }) {
  const st: Step = { ...s, chainT: s.chainTs != null && openAtForSteps ? s.chainTs - openAtForSteps : null, wallMs: s.wallMs ?? 0 }
  steps.push(st)
  const t = st.chainT === null ? '' : ` t=${st.chainT >= 0 ? '+' : ''}${st.chainT}s`
  out(`  [step] ${st.what} (${st.who})${st.gas !== null ? ` gas ${st.gas}` : ''}${t}${st.wallMs ? ` ${st.wallMs} ms` : ''}${st.note ? ` - ${st.note}` : ''}`)
}

// ── ABIs ────────────────────────────────────────────────────────────────
const ROUNDS_ART = artifact('PoolRounds.sol/PoolRounds.json')
const R_ABI = ROUNDS_ART.abi
const WETH_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function mint(address,uint256)',
  'function deposit() payable',
])
/** ETH a player keeps for gas on top of the stakes it may have to wrap. */
const GAS_RESERVE = 2n * 10n ** 14n
/** Whether the WETH is the mintable stand-in (MockWETH) or deposit-backed (TestWETH, no mint). */
const canMintWeth = (weth: Address, from: Address) =>
  pub.simulateContract({ account: from, address: weth, abi: WETH_ABI, functionName: 'mint', args: [from, 1n] } as any).then(() => true, () => false)
/** The stakes of a cycle from the contract's own parameters: TIE at the smallest bank that activates, A at twice that, ONE as TIE. */
function stakesFor(p: { minStake: bigint; maxStake: bigint; minBank: bigint }) {
  const tieStake = p.minBank / 2n > p.minStake ? p.minBank / 2n : p.minStake
  const winStake = tieStake * 2n <= p.maxStake ? tieStake * 2n : p.maxStake
  return { tieStake, winStake, oneStake: tieStake }
}
const POOL_ABI = parseAbi([
  'function pushTick(uint32 startTs, int24 tick)',
  'function setCardinality(uint16 c, uint16 next)',
  'function setLiquidity(uint128 l)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function token0() view returns (address)',
  'function segments(uint256) view returns (uint32 startTs, int24 tick)',
])
const REG_ABI = parseAbi([
  'function marketFactory() view returns (address)',
  'function authorizedMarkets(address) view returns (bool)',
  'function owner() view returns (address)',
  'function referrerOf(address) view returns (address)',
])
const V3F_ABI = parseAbi(['function register(address,address,uint24,address)'])

// ── the network: clients, a player, the clock ─────────────────────────────
interface Actor { name: string; account: PrivateKeyAccount; wallet: ReturnType<typeof createWalletClient> }
let pub: PublicClient
let chain: ReturnType<typeof defineChain>
let rpcUrl = ''
let anvil: ChildProcess | null = null
let testClient: ReturnType<typeof createTestClient> | null = null
let closeProxy: (() => void) | null = null

function actor(name: string, key: Hex): Actor {
  const account = privateKeyToAccount(key)
  return { name, account, wallet: createWalletClient({ account, chain, transport: http(rpcUrl) }) }
}
async function head() {
  const b = await pub.getBlock({ blockTag: 'latest' })
  return { number: b.number!, ts: Number(b.timestamp) }
}
const read = <R = any,>(address: Address, abi: any, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args } as any) as Promise<R>

/** Send, wait, require success. Returns the receipt and the wall time. */
async function send(a: Actor, address: Address, abi: any, functionName: string, args: unknown[] = [], value?: bigint) {
  const s = Date.now()
  const hash = await a.wallet.writeContract({ address, abi, functionName, args, chain, account: a.account, ...(value !== undefined ? { value } : {}) } as any)
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (r.status !== 'success') throw new Error(`${a.name} ${functionName} reverted, tx ${hash}`)
  const b = await pub.getBlock({ blockNumber: r.blockNumber })
  return { r, hash, ms: Date.now() - s, ts: Number(b.timestamp) }
}

/** What a call would revert with, by error name, without sending it. */
async function dryRunError(a: Address, fn: string, args: unknown[], from: Address): Promise<string> {
  try {
    await pub.simulateContract({ account: from, address: a, abi: R_ABI, functionName: fn, args } as any)
    return 'no revert'
  } catch (e: any) {
    const r = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? r.shortMessage
    return String(e?.shortMessage ?? e?.message ?? e).split('\n')[0]
  }
}

// ── keeper, inline (the real backend code) or external (the deployed one) ─
interface KeeperSide {
  kind: 'inline' | 'external'
  address: Address | null
  tick?: () => Promise<any>
  store?: any
  cfg?: any
}
let keeper: KeeperSide = { kind: 'external', address: null }
const keeperTxs: Array<{ action: string; roundId: bigint | null; hash: Hex; gasUsed: bigint; costWei: bigint; ts: number }> = []

async function keeperTick(label: string): Promise<any[]> {
  if (keeper.kind !== 'inline') return []
  const s = Date.now()
  const rep = await keeper.tick!()
  const ms = Date.now() - s
  const sent: any[] = []
  for (const a of rep.actions ?? []) {
    const o = a.outcome
    if (o.kind === 'sent') {
      const rc = await pub.getTransactionReceipt({ hash: o.hash })
      const b = await pub.getBlock({ blockNumber: rc.blockNumber })
      keeperTxs.push({ action: a.action, roundId: a.roundId, hash: o.hash, gasUsed: o.gasUsed, costWei: o.costWei, ts: Number(b.timestamp) })
      sent.push(a)
      record({ what: `keeper ${a.action}${a.roundId !== null ? ` ${roundName(a.roundId)}` : ''}`, who: 'keeper', gas: o.gasUsed, tx: o.hash, chainTs: Number(b.timestamp), note: `${o.status}, limit ${o.gasLimit}, ${o.costWei} wei` })
    } else {
      out(`  keeper ${a.action}${a.roundId !== null ? ` ${roundName(a.roundId)}` : ''}: ${o.kind}${o.error ? ` ${o.error}` : ''}${o.why ? ` ${o.why}` : ''}`)
    }
  }
  const dropped = (rep.dropped ?? []).map((d: any) => `${roundName(d.roundId)} ${d.why}`).join(', ')
  out(`  keeper tick @${label}: ${ms} ms, ${sent.length} tx${dropped ? `, dropped: ${dropped}` : ''}`)
  return sent
}

// ── the rounds ───────────────────────────────────────────────────────────
const names = new Map<string, string>()
const roundName = (id: bigint | null) => (id === null ? '-' : names.get(id.toString()) ?? `#${id.toString().slice(-6)}`)

interface Ctx {
  rounds: Address
  weth: Address
  treasury: Address
  win: Address
  tie: Address
  one: Address
  /** An old-style stand-in (no secondsPerLiquidity) raised to pass the gate: its round must end REFUND (thin). */
  trap?: Address | null
  p1: Actor
  p2: Actor
  ref: Actor
  pusher: Actor
  advanceTo(ts: number, why: string): Promise<void>
  mintWeth: boolean
}

async function waitStrike(ctx: Ctx, ids: bigint[], deadline: number) {
  // External keeper: poll the contract until every round has its strike, or the deadline passes.
  for (;;) {
    const views = await Promise.all(ids.map((id) => read(ctx.rounds, R_ABI, 'roundView', [id])))
    if (views.every((v: any) => v.strikeFixed || Number(v.outcome) !== 0)) return
    if ((await head()).ts > deadline) return
    await sleep(5_000)
  }
}
async function waitSettled(ctx: Ctx, ids: bigint[], deadline: number) {
  for (;;) {
    const views = await Promise.all(ids.map((id) => read(ctx.rounds, R_ABI, 'roundView', [id])))
    if (views.every((v: any) => Number(v.outcome) !== 0)) return
    if ((await head()).ts > deadline) return
    await sleep(5_000)
  }
}

/** Block and tx of the first event `name` for `roundId` from `fromBlock` on. */
async function eventTx(ctx: Ctx, name: 'StrikeFixed' | 'RoundSettled', roundId: bigint, fromBlock: bigint) {
  const ev = R_ABI.find((i: any) => i.type === 'event' && i.name === name)
  const logs = await pub.getLogs({ address: ctx.rounds, event: ev, args: { roundId }, fromBlock, toBlock: 'latest' } as any)
  if (!logs.length) return null
  const l: any = logs[0]
  const rc = await pub.getTransactionReceipt({ hash: l.transactionHash })
  const b = await pub.getBlock({ blockNumber: rc.blockNumber })
  return { hash: l.transactionHash as Hex, gasUsed: rc.gasUsed, ts: Number(b.timestamp), from: rc.from, args: l.args }
}

async function runCycle(ctx: Ctx) {
  const p = {
    minStake: await read<bigint>(ctx.rounds, R_ABI, 'minStake'),
    maxStake: await read<bigint>(ctx.rounds, R_ABI, 'maxStake'),
    minBank: await read<bigint>(ctx.rounds, R_ABI, 'minBank'),
    costAllowance: await read<bigint>(ctx.rounds, R_ABI, 'costAllowance'),
    ratio: await read<bigint>(ctx.rounds, R_ABI, 'maxSideRatio'),
    grace: Number(await read<bigint>(ctx.rounds, R_ABI, 'SETTLE_GRACE')),
    minCardinality: Number(await read<bigint>(ctx.rounds, R_ABI, 'minCardinality')),
    depthPerBank: await read<bigint>(ctx.rounds, R_ABI, 'depthPerBank'),
    gateDepth: await read<bigint>(ctx.rounds, R_ABI, 'gateDepth'),
  }
  out(`\n== cycle: rounds of ${T} s on ${ctx.rounds}`)
  out(`  params: stake ${fmtEth(p.minStake)}-${fmtEth(p.maxStake)}, minBank ${fmtEth(p.minBank)}, costAllowance ${formatGwei(p.costAllowance)} gwei, side cap ${p.ratio}, grace ${p.grace} s, minCardinality ${p.minCardinality}, depthPerBank ${p.depthPerBank}, gateDepth ${fmtEth(p.gateDepth, 2)} (all read from the contract)`)
  check(await read<boolean>(ctx.rounds, R_ABI, 'durationEnabled', [BigInt(T)]), `duration ${T} s enabled`)
  for (const [n, a] of [['win', ctx.win], ['tie', ctx.tie], ['one', ctx.one], ...(ctx.trap ? [['old-style', ctx.trap]] : [])] as Array<[string, Address]>) {
    const cfg = await read<any>(ctx.rounds, R_ABI, 'pools', [a])
    check(Boolean(cfg[0] ?? cfg.listed), `pool ${n} ${a} listed`)
  }

  // Stakes: the tie round at the smallest bank that activates, the winner round at twice that.
  const { tieStake, winStake, oneStake } = stakesFor(p)
  const trapStake = ctx.trap ? tieStake : 0n
  const need1 = winStake + tieStake + oneStake + trapStake
  const need2 = winStake + tieStake + trapStake
  for (const [n, pool, bank] of [['win', ctx.win, 2n * winStake], ['tie', ctx.tie, 2n * tieStake]] as Array<[string, Address, bigint]>) {
    const maxBank = await read<bigint>(ctx.rounds, R_ABI, 'maxBankOf', [pool])
    check(maxBank >= bank, `pool ${n}: maxBankOf ${fmtEth(maxBank)} (depth / depthPerBank) admits a bank of ${fmtEth(bank)}`)
  }

  const bal = (a: Address) => read<bigint>(ctx.weth, WETH_ABI, 'balanceOf', [a])
  out('\n-- players')
  const mintable = ctx.mintWeth ? await canMintWeth(ctx.weth, ctx.p1.account.address) : false
  if (ctx.mintWeth) out(`  WETH ${ctx.weth}: ${mintable ? 'mintable stand-in' : 'deposit-backed, the stakes are wrapped from each player\'s own ETH'}`)
  for (const [a, need] of [[ctx.p1, need1], [ctx.p2, need2]] as const) {
    const have = await bal(a.account.address)
    if (ctx.mintWeth && have < need) {
      if (mintable) {
        const s = await send(a, ctx.weth, WETH_ABI, 'mint', [a.account.address, need])
        record({ what: 'mint stand-in WETH', who: a.name, gas: s.r.gasUsed, tx: s.hash, chainTs: s.ts, wallMs: s.ms, note: fmtEth(need) })
      } else {
        const short = need - have
        const eth = await pub.getBalance({ address: a.account.address })
        if (eth < short + GAS_RESERVE) throw new Error(`${a.name} ${a.account.address} has ${fmtEth(eth)} ETH and needs ${fmtEth(short + GAS_RESERVE)} (${fmtEth(short)} to wrap plus gas): top it up from the testnet faucet first`)
        const s = await send(a, ctx.weth, WETH_ABI, 'deposit', [], short)
        record({ what: 'wrap ETH into WETH', who: a.name, gas: s.r.gasUsed, tx: s.hash, chainTs: s.ts, wallMs: s.ms, note: fmtEth(short) })
      }
    }
    const s = await send(a, ctx.weth, WETH_ABI, 'approve', [ctx.rounds, need])
    record({ what: 'approve exactly the stakes', who: a.name, gas: s.r.gasUsed, tx: s.hash, chainTs: s.ts, wallMs: s.ms, note: fmtEth(need) })
  }

  // ── the window ──
  const now = (await head()).ts
  const openAt = (Math.floor(now / T) + 1) * T
  openAtForSteps = openAt
  const k = BigInt(openAt / T)
  const [A, TIE, ONE] = await Promise.all([ctx.win, ctx.tie, ctx.one].map((pool) => read<bigint>(ctx.rounds, R_ABI, 'roundIdOf', [pool, BigInt(T), k])))
  names.set(A.toString(), 'A'); names.set(TIE.toString(), 'TIE'); names.set(ONE.toString(), 'ONE')
  const OLD = ctx.trap ? await read<bigint>(ctx.rounds, R_ABI, 'roundIdOf', [ctx.trap, BigInt(T), k]) : null
  if (OLD !== null) names.set(OLD.toString(), 'OLD')
  // The keeper's deadlines as the contract states them (keeperDeadlines: the last second the windows
  // are guaranteed readable on a pool that writes an observation every second).
  const [fixStrikeBy, settleBy] = (await read<[bigint, bigint]>(ctx.rounds, R_ABI, 'keeperDeadlines', [A])).map(Number)
  const times = await read<any>(ctx.rounds, R_ABI, 'roundTimes', [A])
  const tm = { openAt: Number(times.openAt), closeAt: Number(times.closeAt), strikeStart: Number(times.strikeStart), strikeEnd: Number(times.strikeEnd), settleAt: Number(times.settleAt) }
  out(`\n-- window ${k}: openAt ${tm.openAt}, closeAt +${tm.closeAt - openAt}, strikeStart +${tm.strikeStart - openAt}, strikeEnd +${tm.strikeEnd - openAt}, settleAt +${tm.settleAt - openAt} (seconds from openAt)`)
  out(`   keeperDeadlines: fixStrike by strikeEnd + ${fixStrikeBy - tm.strikeEnd} s, settle by settleAt + ${settleBy - tm.settleAt} s`)
  check(tm.openAt === openAt && tm.closeAt === openAt + T, 'roundTimes: openAt = k*T, closeAt = openAt + T')
  await ctx.advanceTo(openAt, 'openAt')

  // ── bets ──
  out('\n-- bets (open)')
  const bet = async (a: Actor, id: bigint, stake: bigint, side: 1 | 2, referrer: Address) => {
    const s = await send(a, ctx.rounds, R_ABI, 'bet', [id, stake, side, referrer])
    const opened = parseEventLogs({ abi: R_ABI, logs: s.r.logs, eventName: 'RoundOpened' }).length > 0
    record({ what: `bet ${side === 1 ? 'UP' : 'DOWN'} ${fmtEth(stake)} on ${roundName(id)}${referrer !== ZERO ? ' with a referrer' : ''}${opened ? ' (opens the round)' : ''}`, who: a.name, gas: s.r.gasUsed, tx: s.hash, chainTs: s.ts, wallMs: s.ms, note: '' })
    return s
  }
  await bet(ctx.p1, A, winStake, 1, ctx.ref.account.address)
  await bet(ctx.p2, A, winStake, 2, ZERO)
  await bet(ctx.p1, TIE, tieStake, 1, ZERO)
  await bet(ctx.p2, TIE, tieStake, 2, ZERO)
  await bet(ctx.p1, ONE, oneStake, 1, ZERO)
  if (OLD !== null) {
    await bet(ctx.p1, OLD, trapStake, 1, ZERO)
    await bet(ctx.p2, OLD, trapStake, 2, ZERO)
  }
  check((await dryRunError(ctx.rounds, 'bet', [A, winStake, 1, ZERO], ctx.p1.account.address)) === 'AlreadyBet', 'a second bet by the same player in the same round is refused (AlreadyBet)')
  check((await read<Address>((await read<Address>(ctx.rounds, R_ABI, 'referralRegistry')), REG_ABI, 'referrerOf', [ctx.p1.account.address])).toLowerCase() === ctx.ref.account.address.toLowerCase(),
    'the bet recorded the referral link in the registry (setMarketFactory + authorizeMarket wiring works)')
  await keeperTick('collecting')

  // ── closeAt: the book is final ──
  await ctx.advanceTo(tm.closeAt, 'closeAt')
  out('\n-- closeAt: book final')
  check((await dryRunError(ctx.rounds, 'bet', [A, winStake, 2, ZERO], ctx.pusher.account.address)) === 'NotCollecting', 'a bet at closeAt is refused (NotCollecting)')
  const vA = await read<any>(ctx.rounds, R_ABI, 'roundView', [A])
  const vT = await read<any>(ctx.rounds, R_ABI, 'roundView', [TIE])
  const vO = await read<any>(ctx.rounds, R_ABI, 'roundView', [ONE])
  check(vA.activated && vA.bank === 2n * winStake, `A activated, bank ${fmtEth(vA.bank)}`)
  check(vT.activated && vT.bank === 2n * tieStake, `TIE activated at the smallest bank, ${fmtEth(vT.bank)}`)
  check(!vO.activated && vO.bookClosed, 'ONE (one side only) not activated')
  if (OLD !== null) check((await read<any>(ctx.rounds, R_ABI, 'roundView', [OLD])).activated, 'OLD activated (the gate let the old-style pool in)')
  {
    const before = await bal(ctx.p1.account.address)
    const s = await send(ctx.p1, ctx.rounds, R_ABI, 'claim', [ONE])
    const got = (await bal(ctx.p1.account.address)) - before
    record({ what: 'claim ONE: the whole stake back at closeAt', who: 'p1', gas: s.r.gasUsed, tx: s.hash, chainTs: s.ts, wallMs: s.ms, note: fmtEth(got) })
    check(got === oneStake, `ONE refunded in full at closeAt: ${fmtEth(got)} = stake`)
  }
  await keeperTick('closeAt')

  // ── strikeStart: the pause is over, the strike window runs ──
  await ctx.advanceTo(tm.strikeStart, 'strikeStart')
  out('\n-- strikeStart (pause over, strike window running)')
  await keeperTick('strikeStart')

  // ── strikeEnd: fixStrike is due ──
  const strikeBlock = (await head()).number
  await ctx.advanceTo(tm.strikeEnd, 'strikeEnd')
  out(`\n-- strikeEnd: fixStrike due (by keeperDeadlines().fixStrikeBy, strikeEnd + ${fixStrikeBy - tm.strikeEnd} s)`)
  check((await dryRunError(ctx.rounds, 'fixStrike', [ONE], ctx.pusher.account.address)) === 'NotActivated', 'fixStrike on ONE is refused (NotActivated): nothing for the keeper to pay')
  if (keeper.kind === 'inline') await keeperTick('strikeEnd')
  else await waitStrike(ctx, [A, TIE, ...(OLD !== null ? [OLD] : [])], fixStrikeBy)
  for (const id of [A, TIE]) {
    const e = await eventTx(ctx, 'StrikeFixed', id, strikeBlock)
    check(e !== null, `StrikeFixed for ${roundName(id)}`)
    if (e) {
      const lag = e.ts - tm.strikeEnd
      if (keeper.kind === 'external') record({ what: `fixStrike ${roundName(id)} (deployed keeper ${e.from})`, who: 'keeper', gas: e.gasUsed, tx: e.hash, chainTs: e.ts, note: '' })
      check(lag >= 0 && e.ts <= fixStrikeBy, `fixStrike ${roundName(id)} ${lag} s after strikeEnd (keeperDeadlines allows ${fixStrikeBy - tm.strikeEnd})`)
    }
  }
  if (OLD !== null) {
    const e = await eventTx(ctx, 'RoundSettled', OLD, strikeBlock)
    check(e !== null && Number(e.args.outcome) === 4 && Number(e.args.reason) === 4,
      `OLD ended at fixStrike: ${e ? `outcome ${Number(e.args.outcome)} reason ${Number(e.args.reason)}` : 'no RoundSettled'} (expected REFUND, reason 4 thin: the old mock reports no secondsPerLiquidity, so the strike window carried depth 0)`)
  }
  check((await dryRunError(ctx.rounds, 'settle', [A], ctx.pusher.account.address)) === 'NotDue', 'settle before settleAt is refused (NotDue)')

  // ── one price step on the winner pool, after the strike window ──
  {
    // UP means the meme token dearer in WETH: a higher tick when WETH is token1, a lower one when it is token0.
    const wethIsToken0 = Boolean((await read<any>(ctx.rounds, R_ABI, 'pools', [ctx.win]))[1])
    const tick = Number((await read<any>(ctx.win, POOL_ABI, 'slot0'))[1])
    const next = wethIsToken0 ? tick - 200 : tick + 200
    let startTs = tm.strikeEnd
    const nowTs = (await head()).ts
    try {
      await pub.simulateContract({ account: ctx.pusher.account, address: ctx.win, abi: POOL_ABI, functionName: 'pushTick', args: [startTs, next] })
    } catch { startTs = nowTs + 1 } // somebody pushed after strikeEnd: step from now on
    const s = await send(ctx.pusher, ctx.win, POOL_ABI, 'pushTick', [startTs, next])
    record({ what: `price step on the winner pool: tick ${tick} -> ${next} (WETH is token${wethIsToken0 ? 0 : 1}) from ${startTs === tm.strikeEnd ? 'strikeEnd' : 'now'}`, who: ctx.pusher.name, gas: s.r.gasUsed, tx: s.hash, chainTs: s.ts, wallMs: s.ms, note: 'stand-in only; +1 stored step for good' })
  }
  await keeperTick('after the price step')

  // ── settleAt ──
  const settleBlock = (await head()).number
  await ctx.advanceTo(tm.settleAt, 'settleAt')
  out(`\n-- settleAt: settle due (by keeperDeadlines().settleBy, settleAt + ${settleBy - tm.settleAt} s)`)
  if (keeper.kind === 'inline') await keeperTick('settleAt')
  else await waitSettled(ctx, [A, TIE], settleBy)
  const settled: Record<string, any> = {}
  for (const id of [A, TIE]) {
    const e = await eventTx(ctx, 'RoundSettled', id, settleBlock)
    check(e !== null, `RoundSettled for ${roundName(id)}`)
    if (!e) continue
    settled[id.toString()] = e.args
    const lag = e.ts - tm.settleAt
    if (keeper.kind === 'external') record({ what: `settle ${roundName(id)} (deployed keeper ${e.from})`, who: 'keeper', gas: e.gasUsed, tx: e.hash, chainTs: e.ts, note: '' })
    check(lag >= 0 && e.ts <= settleBy, `settle ${roundName(id)} ${lag} s after settleAt (keeperDeadlines allows ${settleBy - tm.settleAt})`)
  }
  const oA = Number(settled[A.toString()]?.outcome ?? 0)
  const oT = Number(settled[TIE.toString()]?.outcome ?? 0)
  const OUT = ['NONE', 'UP', 'DOWN', 'TIE', 'REFUND']
  check(oA === 1, `A settled ${OUT[oA]} (price stepped up after the strike): expected UP`)
  check(oT === 3, `TIE settled ${OUT[oT]} (no price step): expected TIE${TESTNET ? ' - on the testnet another process may have moved this pool' : ''}`)

  // ── claims ──
  out('\n-- claims')
  const ref = ctx.ref.account.address
  const owedBefore = await read<bigint>(ctx.rounds, R_ABI, 'referralOwed', [ref])
  let paidOut = oneStake
  let refShares = 0n
  let houseShares = 0n
  const claim = async (a: Actor, id: bigint, expect: bigint | null, label: string) => {
    const [payout, share] = await read<[bigint, bigint]>(ctx.rounds, R_ABI, 'previewClaim', [id, a.account.address])
    const before = await bal(a.account.address)
    const s = await send(a, ctx.rounds, R_ABI, 'claim', [id])
    const got = (await bal(a.account.address)) - before
    const ev: any = parseEventLogs({ abi: R_ABI, logs: s.r.logs, eventName: 'Claimed' })[0]?.args
    record({ what: `claim ${roundName(id)}: ${label}`, who: a.name, gas: s.r.gasUsed, tx: s.hash, chainTs: s.ts, wallMs: s.ms, note: `${fmtEth(got)} WETH, referral share ${share} wei${ev?.referrer && ev.referrer !== ZERO ? ' to the referrer' : ' to the treasury'}` })
    check(got === payout, `${a.name} ${roundName(id)}: received ${fmtEth(got)} = previewClaim`)
    if (expect !== null) check(got === expect, `${a.name} ${roundName(id)}: ${fmtEth(got)} = expected ${fmtEth(expect)}`)
    paidOut += got
    if (ev?.referrer && ev.referrer !== ZERO) refShares += share
    else houseShares += share
    return got
  }
  const bankA = 2n * winStake
  const bankT = 2n * tieStake
  // positive-ev.mts: winner stake x (bank - 2%) / sideRaw = 1.96x of the accepted part; tie stake x accepted x (bank - 1%) / (sideRaw x bank).
  const winPays = (winStake * (bankA - (bankA * 200n) / 10_000n)) / winStake
  const tiePays = (tieStake * tieStake * (bankT - (bankT * 100n) / 10_000n)) / (tieStake * bankT)
  await claim(ctx.p1, A, oA === 1 ? winPays : null, oA === 1 ? 'winner, 1.96x' : OUT[oA])
  await claim(ctx.p2, A, oA === 1 ? 0n : null, oA === 1 ? 'loser, nothing to transfer' : OUT[oA])
  await claim(ctx.p1, TIE, oT === 3 ? tiePays : null, oT === 3 ? 'tie, stake less 1%' : OUT[oT])
  await claim(ctx.p2, TIE, oT === 3 ? tiePays : null, oT === 3 ? 'tie, stake less 1%' : OUT[oT])
  if (OLD !== null) {
    await claim(ctx.p1, OLD, tiePays, 'REFUND (thin), stake less 1%')
    await claim(ctx.p2, OLD, tiePays, 'REFUND (thin), stake less 1%')
  }
  check((await dryRunError(ctx.rounds, 'claim', [A], ctx.p1.account.address)) === 'AlreadyClaimed', 'a second claim is refused (AlreadyClaimed)')

  // ── referral ──
  const owed = await read<bigint>(ctx.rounds, R_ABI, 'referralOwed', [ref])
  check(owed - owedBefore === refShares && refShares > 0n, `referrer owed ${owed - owedBefore} wei = the shares of p1's tickets (the registry link is global: it also covers p1's TIE ticket)`)
  if (owed > 0n) {
    const before = await bal(ref)
    const s = await send(ctx.ref, ctx.rounds, R_ABI, 'claimReferral', [])
    const got = (await bal(ref)) - before
    record({ what: 'claimReferral', who: 'referrer', gas: s.r.gasUsed, tx: s.hash, chainTs: s.ts, wallMs: s.ms, note: `${got} wei` })
    check(got === owed, `referrer received ${got} wei`)
  }

  // ── fees ──
  out('\n-- fees')
  await keeperTick('after the claims')
  const accrued = await read<bigint>(ctx.rounds, R_ABI, 'feesAccrued')
  if (accrued > 0n) {
    const s = await send(ctx.pusher, ctx.rounds, R_ABI, 'withdrawFees', [])
    record({ what: 'withdrawFees (anyone may call)', who: ctx.pusher.name, gas: s.r.gasUsed, tx: s.hash, chainTs: s.ts, wallMs: s.ms, note: `${accrued} wei to the treasury` })
  }
  check((await read<bigint>(ctx.rounds, R_ABI, 'feesAccrued')) === 0n, 'feesAccrued is 0 after withdrawal')

  // ── money: nothing created, nothing lost ──
  const bankOld = 2n * trapStake
  const gross = (bankA * BigInt(oA === 3 || oA === 4 ? 100 : 200)) / 10_000n + (bankT * BigInt(oT === 3 || oT === 4 ? 100 : 200)) / 10_000n + (bankOld * 100n) / 10_000n
  const staked = 2n * winStake + 2n * tieStake + oneStake + 2n * trapStake
  const dust = staked - paidOut - gross
  check(dust >= 0n && dust < 10n, `stakes ${fmtEth(staked)} = payouts ${fmtEth(paidOut)} + fees ${fmtEth(gross)} + dust ${dust} wei`)
  const potA = ((bankA * BigInt(oA === 3 || oA === 4 ? 100 : 200)) / 10_000n) / 10n
  const potT = ((bankT * BigInt(oT === 3 || oT === 4 ? 100 : 200)) / 10_000n) / 10n
  const potOld = ((bankOld * 100n) / 10_000n) / 10n
  check(refShares + houseShares <= potA + potT + potOld, `referral shares ${refShares} + house shares ${houseShares} <= pots ${potA + potT + potOld} wei`)
  return { A, TIE, ONE, OLD, tm, p, bankA, bankT }
}

// ── --local ──────────────────────────────────────────────────────────────
async function mainLocal() {
  const url = opt('--anvil-url')
  let anvilUrl: string
  if (url) {
    if (!isLocalUrl(url)) throw new Error(`--anvil-url must be 127.0.0.1 or localhost, got ${url}`)
    anvilUrl = url
  } else {
    const port = 20_000 + Math.floor(Math.random() * 20_000)
    anvilUrl = `http://127.0.0.1:${port}`
    anvil = spawn(foundry('anvil'), ['--port', String(port), '--host', '127.0.0.1', '--chain-id', String(TESTNET_ID), '--base-fee', '10000000', '--silent'], { stdio: 'ignore' })
  }
  for (let i = 0; ; i++) {
    try { await fetch(anvilUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); break } catch { if (i > 150) throw new Error('anvil did not start') }
    await sleep(100)
  }
  const proxy = await startChainLikeProxy(anvilUrl)
  closeProxy = proxy.close
  rpcUrl = proxy.url
  chain = defineChain({ id: TESTNET_ID, name: 'local anvil (46630 id only)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } })
  pub = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient
  for (let i = 0; ; i++) {
    try { await pub.getChainId(); break } catch { if (i > 150) throw new Error('anvil did not start') }
    await sleep(100)
  }
  const client = await pub.request({ method: 'web3_clientVersion' as any })
  if (!/anvil/i.test(String(client))) throw new Error(`not an anvil node: ${client}`)
  if ((await pub.getChainId()) !== TESTNET_ID) throw new Error('local anvil must run with --chain-id 46630 (the keeper code signs for the rhc testnet profile)')
  testClient = createTestClient({ mode: 'anvil', chain, transport: http(rpcUrl) })

  const src = readFileSync(join(CONTRACTS, 'src', 'PoolRounds.sol'))
  const script = readFileSync(join(CONTRACTS, 'script', 'DeployPoolRounds.s.sol'))
  out(`# rounds-e2e --local, machine clock ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`)
  out(`anvil ${client} at ${anvilUrl} behind a local gas proxy ${rpcUrl}: chain id ${TESTNET_ID} (a local process, not the network), every block at 0.01 gwei base fee, no tip, as on the testnet`)
  out(`PoolRounds.sol sha256 ${createHash('sha256').update(src).digest('hex').slice(0, 16)}..., DeployPoolRounds.s.sol sha256 ${createHash('sha256').update(script).digest('hex').slice(0, 16)}...`)
  const history = (opt('--history') ?? '1,1,1').split(',').map((x) => Number(x.trim() || '1'))
  out(`stored price steps per stand-in pool (MOONCAT, PEPE, FROGGO): ${history.map((h) => Math.max(1, h)).join(', ')}`)

  // ── accounts, generated here, never printed ──
  const keys = { deployer: generatePrivateKey(), p1: generatePrivateKey(), p2: generatePrivateKey(), ref: generatePrivateKey(), pusher: generatePrivateKey(), keeper: generatePrivateKey() }
  const deployer = actor('deployer', keys.deployer)
  const p1 = actor('p1', keys.p1)
  const p2 = actor('p2', keys.p2)
  const refA = actor('referrer', keys.ref)
  const pusher = actor('anyone', keys.pusher)
  const keeperAddr = privateKeyToAccount(keys.keeper).address
  const treasury = privateKeyToAccount(generatePrivateKey()).address
  const multisig = privateKeyToAccount(generatePrivateKey()).address
  for (const a of [deployer.account.address, p1.account.address, p2.account.address, refA.account.address, pusher.account.address, keeperAddr]) {
    await testClient.setBalance({ address: a, value: 100n * ETH })
  }

  // ── 1. a pool like today's testnet demo pools (AddRhcPool.s.sol): MockUniswapV3Pool, 40 WETH, ring 300 ──
  out('\n== stand-ins: MockWETH, a MockUniswapV3Factory of the rounds, and an old-style pool like the testnet demo pools')
  const deploy = async (rel: string, args: unknown[] = []) => {
    const a = artifact(rel)
    const hash = await deployer.wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args, chain, account: deployer.account } as any)
    const r = await pub.waitForTransactionReceipt({ hash })
    if (r.status !== 'success') throw new Error(`deploy ${rel} reverted`)
    return r.contractAddress as Address
  }
  const weth = await deploy('MockWETH.sol/MockWETH.json')
  const v3 = await deploy('MockUniswapV3Factory.sol/MockUniswapV3Factory.json')
  out(`  WETH ${weth}, v3 factory ${v3}`)
  const t0 = (await head()).ts
  const oldToken = await deploy('MockToken.sol/MockToken.json', ['OLDCAT', 'OLDCAT', 18])
  const [o0, o1] = oldToken.toLowerCase() < weth.toLowerCase() ? [oldToken, weth] : [weth, oldToken]
  const oldPool = await deploy('MockUniswapV3Pool.sol/MockUniswapV3Pool.json', [o0, o1, 10_000])
  await send(deployer, v3, V3F_ABI, 'register', [o0, o1, 10_000, oldPool])
  await send(deployer, oldPool, POOL_ABI, 'pushTick', [t0 - 7200, 0])
  await send(deployer, oldPool, POOL_ABI, 'setLiquidity', [40n * ETH])
  await send(deployer, oldPool, POOL_ABI, 'setCardinality', [300, 300])
  out(`  OLDCAT: MockUniswapV3Pool ${oldPool}, 40 WETH of depth, ring 300/300 (what MOONCAT, PEPE and FROGGO are on the testnet)`)

  const broadcastDir = mkdtempSync(join(tmpdir(), 'rounds-e2e-broadcast-'))
  const base = {
    PRIVATE_KEY: keys.deployer,
    MULTISIG_ADDRESS: multisig,
    TREASURY_ADDRESS: treasury,
    KEEPER_ADDRESS: keeperAddr,
    RHC_WETH_ADDRESS: weth,
    RHC_V3_FACTORY_ADDRESS: v3,
  }
  out('\n== deploy listing the old-style pool as it is (the gate must refuse it, and nothing must be sent)')
  const nonce0 = await pub.getTransactionCount({ address: deployer.account.address })
  let s = Date.now()
  const refused = await runDeployScript({ rpcUrl, vars: { ...base, ROUNDS_POOLS: oldPool }, broadcast: true, chainId: TESTNET_ID, broadcastDir })
  const text = refused.stdout + refused.stderr
  const reason = text.match(/(PoolTooThin|CardinalityTooLow|PoolCannotServeWindow|NotCanonicalPool|NotWethPool)\([^)]*\)/)?.[0] ?? text.split('\n').find((l) => /revert|Error/i.test(l))?.trim()
  check(refused.code !== 0 && /PoolTooThin|CardinalityTooLow/.test(reason ?? ''), `forge script stopped (exit ${refused.code}) in ${Date.now() - s} ms: ${reason ?? 'no reason printed'}`)
  check((await pub.getTransactionCount({ address: deployer.account.address })) === nonce0, 'nothing was broadcast: the deployer nonce did not move (forge simulates the whole script first)')

  // ── 2. new stand-ins, exactly as rounds-deploy.mts makes them for the testnet ──
  out('\n== new stand-ins for the rounds (rounds-lib.mts deployRoundStandins, the code rounds-deploy.mts runs)')
  // The gate the script's deployment will apply, read from DeployPoolRounds.s.sol and PoolRounds.sol.
  const gate = plannedGate()
  const minCard = gate.minCardinality
  const depthEth = standinDepthEth(gate.gateDepth)
  out(`  gate the deployment will apply (from the sources): depth >= depthPerBank ${gate.depthPerBank} x minBank ${fmtEth(gate.minBank)} = ${fmtEth(gate.gateDepth, 2)} WETH, ring >= ${minCard}; new pools get ${depthEth} WETH`)
  s = Date.now()
  const st = await deployRoundStandins({
    pub, wallet: createWalletClient({ account: deployer.account, chain, transport: http(rpcUrl) }), weth, factory: v3,
    tokens: [{ symbol: 'MOONCAT' }, { symbol: 'PEPE' }, { symbol: 'FROGGO' }], depthEth, ring: minCard, history,
    log: (l) => out(`  ${l}`),
  })
  const standinGas = st.txs.reduce((a, t) => a + t.gas, 0n)
  record({ what: `new stand-ins: ${st.txs.length} transactions (3 tokens, 3 pools, register, history, liquidity, ring)`, who: 'deployer', gas: standinGas, tx: null, chainTs: null, wallMs: Date.now() - s, note: '' })
  const pools = st.pools.map((p) => p.pool)

  // ── 3. the old-style pool, raised to pass the gate: it lists, and its round must end REFUND (thin) ──
  out(`\n== the old-style pool raised to pass the gate (depth ${depthEth} WETH, ring ${minCard}): what raising the demo pools would do`)
  await send(pusher, oldPool, POOL_ABI, 'setLiquidity', [depthEth * ETH])
  await send(pusher, oldPool, POOL_ABI, 'setCardinality', [minCard, minCard])

  out('\n== deploy: forge script script/DeployPoolRounds.s.sol --broadcast --slow (this anvil)')
  s = Date.now()
  const dep = await runDeployScript({ rpcUrl, vars: { ...base, ROUNDS_POOLS: [...pools, oldPool].join(',') }, broadcast: true, chainId: TESTNET_ID, broadcastDir })
  if (dep.code !== 0 || !dep.rounds || !dep.registry) {
    out(dep.stdout.slice(-3000)); out(dep.stderr.slice(-3000))
    throw new Error('deployment failed')
  }
  out(`  forge script: ${Date.now() - s} ms, ${dep.txs.length} transactions, POOL_ROUNDS=${dep.rounds}, POOL_ROUNDS_REFERRAL_REGISTRY=${dep.registry}`)
  let deployGas = 0n
  for (const t of dep.txs) {
    record({ what: t.what, who: 'deployer', gas: t.gasUsed, tx: t.hash, chainTs: null, note: `block ${t.block}` })
    deployGas += t.gasUsed
  }
  out(`  deployment total ${deployGas} gas (L2 execution; the L1 part is added on RHC, see ROUNDS-DEPLOY.md)`)
  const deployBlock = dep.txs.length ? dep.txs[0].block : 0n

  out('\n== wiring as the script left it')
  const rounds = dep.rounds
  const registry = dep.registry
  check((await read<Address>(rounds, R_ABI, 'owner')) === deployer.account.address, 'owner = deployer (no handover on 46630 without RHC_HANDOVER)')
  check((await read<Address>(rounds, R_ABI, 'pendingOwner')) === ZERO, 'no pending owner')
  check((await read<Address>(rounds, R_ABI, 'pauser')) === keeperAddr, 'pauser = KEEPER_ADDRESS')
  check((await read<Address>(rounds, R_ABI, 'treasury')) === treasury, 'treasury = TREASURY_ADDRESS')
  check((await read<Address>(rounds, R_ABI, 'referralRegistry')) === registry, 'PoolRounds reads the new registry')
  check((await read<Address>(registry, REG_ABI, 'marketFactory')) === rounds, 'registry.marketFactory = PoolRounds')
  check(await read<boolean>(registry, REG_ABI, 'authorizedMarkets', [rounds]), 'registry.authorizedMarkets(PoolRounds) = true')
  check((await read<Address>(registry, REG_ABI, 'owner')) === deployer.account.address, 'registry owner = deployer')
  // Every parameter as DeployPoolRounds.s.sol's own default says, read from its source.
  const defaults: Array<[string, bigint]> = [
    ['maxSideRatio', deployScriptDefault('ROUNDS_MAX_SIDE_RATIO')], ['strikePause', deployScriptDefault('ROUNDS_STRIKE_PAUSE')],
    ['strikeWindow', deployScriptDefault('ROUNDS_STRIKE_WINDOW')], ['depthPerBank', deployScriptDefault('ROUNDS_DEPTH_PER_BANK')],
    ['minStake', deployScriptDefault('ROUNDS_MIN_STAKE')], ['maxStake', deployScriptDefault('ROUNDS_MAX_STAKE')],
    ['minBank', deployScriptDefault('ROUNDS_MIN_BANK')], ['costAllowance', deployScriptDefault('ROUNDS_COST_ALLOWANCE')],
    ['minCardinality', BigInt(minCard)], ['gateDepth', gate.gateDepth],
  ]
  for (const [fn, v] of defaults) check((await read<bigint>(rounds, R_ABI, fn)) === v, `${fn} = ${v}`)
  check((await dryRunError(rounds, 'listPool', [pools[0]], pusher.account.address)) === 'OwnableUnauthorizedAccount', 'listPool by anyone but the owner is refused')

  // ── the keeper: the real backend/src/rounds code, imported ──
  const km = await loadKeeperCode(rpcUrl, keys.keeper)
  const cfgR = km.readRoundsConfig({
    ROUNDS_ENABLED: 'true',
    ROUNDS_ADDRESS: rounds,
    ROUNDS_START_BLOCK: deployBlock.toString(),
    ROUNDS_FEES_WITHDRAW_MIN_ETH: '0.00001',
  }, (m: string) => out(`  keeper config warning: ${m}`))
  if (!cfgR.enabled) throw new Error(`keeper config: ${cfgR.error}`)
  const wallet = km.getKeeperWalletClient()
  check(wallet.account.address === keeperAddr, 'keeper wallet = KEEPER_ADDRESS (the pauser)')
  const store = new km.MemoryRoundsStore()
  const kc = km.createRoundsKeeper({
    chain: km.createViemRoundsChain({ publicClient: km.viem.createPublicClient({ chain: wallet.chain, transport: km.viem.http(rpcUrl) }), wallet, address: rounds }),
    store,
    sendTx: km.sendKeeperTx,
    gasGuard: { check: async () => null, record: async () => {} },
    config: cfgR.config,
    log: { info: (m: string) => out(`    keeper: ${m}`), warn: (m: string) => out(`    keeper warn: ${m}`), error: (m: string) => out(`    keeper ERROR: ${m}`) },
  })
  keeper = { kind: 'inline', address: keeperAddr, tick: kc.tick, store, cfg: cfgR.config }
  out(`\n== keeper: backend/src/rounds imported, key generated here, interval ${cfgR.config.intervalMs} ms (ticks driven by this script), withdraw threshold ${cfgR.config.feesWithdrawMinWei} wei`)

  const tc = testClient!
  const advanceTo = async (ts: number) => {
    const now = (await head()).ts
    if (now < ts) {
      await tc.setNextBlockTimestamp({ timestamp: BigInt(ts) })
      await tc.mine({ blocks: 1 })
    }
  }
  const treasuryBefore = await read<bigint>(weth, WETH_ABI, 'balanceOf', [treasury])
  const res = await runCycle({ rounds, weth, treasury, win: pools[0], tie: pools[1], one: pools[2], trap: oldPool, p1, p2, ref: refA, pusher, advanceTo, mintWeth: true })

  out('\n== keeper budget and treasury')
  for (const id of [res.A, res.TIE]) {
    const spent: bigint = await store.getSpent(id)
    const cap = (res.p.costAllowance * 8n) / 10n
    check(spent > 0n && spent <= cap, `${roundName(id)}: keeper spent ${spent} wei <= ${cap} (costAllowance less the 20% reserve for the 24 h branch)`)
  }
  const kGas = (id: bigint) => keeperTxs.filter((t) => t.roundId === id).reduce((a, t) => a + t.gasUsed, 0n)
  out(`  keeper gas: A ${kGas(res.A)}, TIE ${kGas(res.TIE)}, ONE ${kGas(res.ONE)} (ONE must be 0)`)
  check(kGas(res.ONE) === 0n, 'the keeper paid nothing for the round that did not activate')
  const treasuryGot = (await read<bigint>(weth, WETH_ABI, 'balanceOf', [treasury])) - treasuryBefore
  out(`  treasury received ${fmtEth(treasuryGot, 8)} WETH in total`)
  const inContract = await read<bigint>(weth, WETH_ABI, 'balanceOf', [rounds])
  check(inContract < 10n, `PoolRounds holds ${inContract} wei after every claim and withdrawal (dust only)`)
}

// ── --testnet ────────────────────────────────────────────────────────────
async function mainTestnet() {
  const YES = has('--yes-testnet')
  rpcUrl = process.env.RHC_RPC_URL ?? TESTNET_RPC
  if (/mainnet/i.test(rpcUrl)) throw new Error(`refusing an RPC that names mainnet: ${rpcUrl}`)
  chain = defineChain({ id: TESTNET_ID, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } })
  pub = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient
  const id = await pub.getChainId()
  if (id !== TESTNET_ID) throw new Error(`chain ${id} is not the testnet ${TESTNET_ID}: refusing`)

  const NAMES = ['ROUNDS_ADDRESS', 'ROUNDS_START_BLOCK', 'ROUNDS_E2E_POOLS']
  const env = { ...readEnvNames(NAMES), ...Object.fromEntries(NAMES.filter((k) => process.env[k]).map((k) => [k, process.env[k] as string])) }
  const rounds = env.ROUNDS_ADDRESS as Address | undefined
  if (!rounds || !/^0x[0-9a-fA-F]{40}$/.test(rounds)) throw new Error('ROUNDS_ADDRESS is not set (set ROUNDS_ADDRESS=0x... in cmd, or add it to the repo .env)')
  let poolList: Address[]
  if (env.ROUNDS_E2E_POOLS) {
    poolList = env.ROUNDS_E2E_POOLS.split(',').map((x) => x.trim()) as Address[]
  } else {
    // The first three pools PoolRounds listed, from its own events.
    if (!env.ROUNDS_START_BLOCK) throw new Error('set ROUNDS_START_BLOCK (or ROUNDS_E2E_POOLS=win,tie,one)')
    const ev = R_ABI.find((i: any) => i.type === 'event' && i.name === 'PoolListed')
    const logs = await pub.getLogs({ address: rounds, event: ev, fromBlock: BigInt(env.ROUNDS_START_BLOCK), toBlock: 'latest' } as any)
    poolList = [...new Set(logs.map((l: any) => l.args.pool as Address))].slice(0, 3)
  }
  if (poolList.length !== 3) throw new Error('three listed pools are needed: win, tie, one (ROUNDS_E2E_POOLS)')
  // ROUNDS_E2E_WALLETS_FILE: other wallets than the soak ones (see rounds-e2e-wallets.mts), when a traffic run is live
  const soak = readSoakKeys(process.env.ROUNDS_E2E_WALLETS_FILE || undefined)
  if (soak.length < 3) throw new Error('the wallets file (scripts/rhc/.soak-wallets.json or ROUNDS_E2E_WALLETS_FILE) needs at least three keys (players and referrer)')
  const p1 = actor('p1', soak[0])
  const p2 = actor('p2', soak[1])
  const ref = actor('referrer', soak[2])
  const mode = (opt('--keeper') ?? 'external') as 'inline' | 'external'
  const keyEnv = opt('--keeper-key-env') ?? 'PRIVATE_KEY'
  if (mode === 'inline' && keyEnv === 'KEEPER_PRIVATE_KEY' && !has('--allow-server-keeper-key')) {
    throw new Error('KEEPER_PRIVATE_KEY is the server keeper\'s wallet: two processes on one wallet collide on nonces. Use another --keeper-key-env')
  }

  // ── plan: reads only ──
  out(`# rounds-e2e --testnet ${YES ? '(SENDING)' : '(plan only, nothing is sent)'}, ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`)
  out(`chain ${id}, RPC ${rpcUrl}, PoolRounds ${rounds}`)
  const isRounds = await read<boolean>(rounds, R_ABI, 'isMarket', [rounds]).catch(() => false)
  const minCard = await read<bigint>(rounds, R_ABI, 'minCardinality').catch(() => 0n)
  if (!isRounds || minCard === 0n) throw new Error(`${rounds} does not answer as PoolRounds`)
  const weth = await read<Address>(rounds, R_ABI, 'weth')
  const treasury = await read<Address>(rounds, R_ABI, 'treasury')
  out(`WETH ${weth}, treasury ${treasury}, minCardinality ${minCard}`)
  const gasPrice = await pub.getGasPrice()
  out(`gas price ${formatGwei(gasPrice)} gwei`)
  // What each player needs: gas, plus the stakes it will have to wrap when the WETH is deposit-backed (TestWETH).
  const mintable = await canMintWeth(weth, p1.account.address)
  const st = stakesFor({
    minStake: await read<bigint>(rounds, R_ABI, 'minStake'), maxStake: await read<bigint>(rounds, R_ABI, 'maxStake'), minBank: await read<bigint>(rounds, R_ABI, 'minBank'),
  })
  const stakes = { p1: st.winStake + st.tieStake + st.oneStake, p2: st.winStake + st.tieStake, referrer: 0n }
  out(`WETH is ${mintable ? 'a mintable stand-in' : 'deposit-backed: each player wraps its own ETH for the stakes'}; stakes A ${fmtEth(st.winStake)} each side, TIE ${fmtEth(st.tieStake)} each side, ONE ${fmtEth(st.oneStake)}`)
  let short = false
  for (const [a, stake, gas] of [[p1, stakes.p1, GAS_RESERVE], [p2, stakes.p2, GAS_RESERVE], [ref, 0n, 5n * 10n ** 13n]] as const) {
    const b = await pub.getBalance({ address: a.account.address })
    const w = stake > 0n ? await read<bigint>(weth, WETH_ABI, 'balanceOf', [a.account.address]) : 0n
    const toWrap = mintable || stake <= w ? 0n : stake - w
    const need = gas + toWrap
    out(`  ${a.name} ${a.account.address}: ${fmtEth(b)} ETH${stake > 0n ? `, ${fmtEth(w)} WETH` : ''} (needs ${fmtEth(need)} ETH${toWrap > 0n ? `: ${fmtEth(toWrap)} to wrap plus gas` : ''})`)
    if (b < need) short = true
  }
  for (const [n, a] of [['win', poolList[0]], ['tie', poolList[1]], ['one', poolList[2]]] as const) {
    const cfg = await read<any>(rounds, R_ABI, 'pools', [a])
    out(`  pool ${n} ${a}: listed ${Boolean(cfg[0] ?? cfg.listed)}`)
  }
  let keeperKey: Hex | null = null
  if (mode === 'inline') {
    keeperKey = asKey(readEnvNames([keyEnv])[keyEnv], keyEnv)
    const ka = privateKeyToAccount(keeperKey).address
    if ([p1, p2, ref].some((a) => a.account.address === ka)) throw new Error('the inline keeper key is also a player key')
    out(`  keeper inline from ${keyEnv}: ${ka}, ${fmtEth(await pub.getBalance({ address: ka }))} ETH`)
  } else {
    out('  keeper: external (the deployed keeper must be running with ROUNDS_ENABLED=true and this ROUNDS_ADDRESS)')
  }
  out(`plan: ${mintable ? 'mint stand-in WETH to' : 'wrap ETH for'} p1 and p2, approve, 5 bets in the next 300 s window (A ${fmtEth(st.winStake)} each side, TIE ${fmtEth(st.tieStake)} each side, ONE ${fmtEth(st.oneStake)} one side),`)
  out('      claim ONE at closeAt, wait strikeEnd (+10 min) for fixStrike, ONE pushTick on the win pool, wait settleAt (+5 min) for settle,')
  out('      4 claims, claimReferral, withdrawFees if anything is left. About 25 minutes; about 2.5 million gas in total for the players and the push.')
  if (short) throw new Error('a wallet is short of testnet ETH (gas, and the stakes to wrap when the WETH is deposit-backed): fund it from the faucet first (see ROUNDS-DEPLOY.md)')
  if (!YES) {
    out('\nnothing sent. To run it: add --yes-testnet')
    return
  }

  if (mode === 'inline') {
    const km = await loadKeeperCode(rpcUrl, keeperKey!)
    const startBlock = process.env.ROUNDS_START_BLOCK ?? (await head()).number.toString()
    const cfgR = km.readRoundsConfig({ ROUNDS_ENABLED: 'true', ROUNDS_ADDRESS: rounds, ROUNDS_START_BLOCK: startBlock, ROUNDS_FEES_WITHDRAW_MIN_ETH: '0.00001' }, (m: string) => out(`  keeper config warning: ${m}`))
    if (!cfgR.enabled) throw new Error(`keeper config: ${cfgR.error}`)
    const wallet = km.getKeeperWalletClient()
    const store = new km.MemoryRoundsStore()
    const kc = km.createRoundsKeeper({
      chain: km.createViemRoundsChain({ publicClient: km.viem.createPublicClient({ chain: wallet.chain, transport: km.viem.http(rpcUrl) }), wallet, address: rounds }),
      store, sendTx: km.sendKeeperTx, gasGuard: { check: async () => null, record: async () => {} }, config: cfgR.config,
      log: { info: (m: string) => out(`    keeper: ${m}`), warn: (m: string) => out(`    keeper warn: ${m}`), error: (m: string) => out(`    keeper ERROR: ${m}`) },
    })
    keeper = { kind: 'inline', address: wallet.account.address, tick: kc.tick, store, cfg: cfgR.config }
  }
  const advanceTo = async (ts: number, why: string) => {
    out(`  waiting for ${why} (${ts})`)
    for (;;) {
      const h = await head()
      if (h.ts >= ts) break
      if (keeper.kind === 'inline') await keeperTick(`waiting for ${why}`)
      await sleep(Math.min(5_000, Math.max(1_000, (ts - h.ts) * 1000)))
    }
  }
  await runCycle({ rounds, weth, treasury, win: poolList[0], tie: poolList[1], one: poolList[2], p1, p2, ref, pusher: p1, advanceTo, mintWeth: true })
}

// ── report ───────────────────────────────────────────────────────────────
function report() {
  out('\n== steps')
  out('| # | step | who | gas | chain time from openAt, s | wall, ms |')
  out('|---:|---|---|---:|---:|---:|')
  steps.forEach((s, i) => out(`| ${i + 1} | ${s.what}${s.note ? ` (${s.note})` : ''} | ${s.who} | ${s.gas ?? ''} | ${s.chainT ?? ''} | ${s.wallMs || ''} |`))
  const failed = checks.filter((c) => !c.ok)
  out(`\n${checks.length} checks, ${failed.length} failed; whole run ${((Date.now() - startedMs) / 1000).toFixed(1)} s wall`)
  for (const f of failed) out(`  FAILED: ${f.what}`)
  out(failed.length ? 'CHECKS FAILED' : 'ALL CHECKS PASSED')
  return failed.length === 0
}

const main = LOCAL ? mainLocal : mainTestnet
main()
  // exitCode, not process.exit: on Windows exiting under open sockets can abort Node with a libuv
  // assertion. The unref'd timer below ends a process that something still holds open.
  .then(() => { const ok = checks.length === 0 || report(); closeProxy?.(); anvil?.kill(); process.exitCode = ok ? 0 : 1 })
  .catch((e) => {
    const msg = String(e?.shortMessage ?? e?.message ?? e).split('\n')[0]
    out(`\nERROR: ${msg}`)
    // an aborted run is a failed run: the report must not say ALL CHECKS PASSED on the checks made before the error
    if (checks.length) { checks.push({ ok: false, what: `run aborted: ${msg}` }); report() }
    closeProxy?.(); anvil?.kill(); process.exitCode = 1
  })
  .finally(() => { setTimeout(() => process.exit(), 15_000).unref() })
