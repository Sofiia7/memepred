import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'

/**
 * The whole cycle on a local anvil, with the real PoolRounds v3 bytecode and
 * the real keeper code: discovery by getLogs, roundTimes, keeperDeadlines and
 * roundView, the planner, the budget and fee bid inside
 * keeperWallet.sendKeeperTx, fixStrike, settle, the 24 h settle, withdrawFees,
 * the gate check and delistIfBelowGate. Deployed the way the forge tests do it
 * (PoolRoundTestBase.sol): MockWETH, MockUniswapV3Factory, PoolRoundMockPool
 * (the stand-in with a liquidity history, which the depth rule reads) with a
 * pushed tick, a ring of minCardinality and 1e9 ETH of liquidity, PoolRounds
 * with side cap 1, a 300 s pause, a 300 s strike window and depthPerBank 2500.
 *
 * Substituted, and only these: Redis (the in-memory store; the Redis store is
 * store.test.ts) and the gas guard's Redis counters (a recorder). The mock
 * pool has no ring to lose, so the hard deadlines are checked here as timing
 * (block timestamps of the keeper's transactions against strikeEnd and
 * settleAt); keeper.test.ts runs them against a pool that forgets.
 *
 * Opt-in: ROUNDS_E2E_ANVIL=1. It starts its own anvil on 127.0.0.1 and refuses
 * any other RPC. Nothing leaves this machine: the keeper key is generated here
 * and funded by anvil_setBalance.
 *
 *   ROUNDS_E2E_ANVIL=1 npx vitest run src/rounds/anvil.e2e.test.ts
 */

const RUN = process.env.ROUNDS_E2E_ANVIL === '1'
const here = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(here, '../../../contracts/out')
const ANVIL = process.env.ANVIL_BIN
  ?? [resolve(process.env.USERPROFILE ?? '', '.foundry/bin/anvil.exe'), resolve(process.env.HOME ?? '', '.foundry/bin/anvil')].find(existsSync)
  ?? 'anvil'

const ETH = 10n ** 18n
const T = 300
const GRACE = 86_400
const CHAIN_ID = 46630 // what CHAIN_PROFILE=rhc signs for; a local anvil, not the network
/** How late after each deadline opens the keeper's tick comes: most of a 10 s poll. */
const POLL_PHASE = 9

function artifact(path: string) {
  const j = JSON.parse(readFileSync(resolve(OUT, path), 'utf8'))
  return { abi: j.abi, bytecode: j.bytecode.object as Hex }
}

const POOL_ADMIN_ABI = parseAbi([
  'function pushTick(uint32 startTs, int24 tick)',
  'function setCardinality(uint16 c, uint16 next)',
  'function setLiquidity(uint128 l)',
  'function setForceOtherRevert(uint8 mode)',
])
const POOL_LIQUIDITY = 10n ** 27n // 1e9 ETH, as PoolRoundTestBase: far above any bank x depthPerBank here

describe.skipIf(!RUN)('rounds keeper on anvil: full cycle, PoolRounds v3', () => {
  let anvil: ChildProcess
  let url: string
  const savedEnv = { ...process.env }
  let pub: PublicClient
  let test: ReturnType<typeof createTestClient>
  const say = (m: string) => console.log(`[e2e] ${m}`)

  beforeAll(async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000)
    url = `http://127.0.0.1:${port}`
    anvil = spawn(ANVIL, ['--port', String(port), '--host', '127.0.0.1', '--chain-id', String(CHAIN_ID), '--silent'], { stdio: 'ignore' })
    pub = createPublicClient({ transport: http(url) }) as PublicClient
    for (let i = 0; ; i++) {
      try { await pub.getChainId(); break } catch { if (i > 100) throw new Error(`anvil did not start (${ANVIL})`) }
      await new Promise((r) => setTimeout(r, 100))
    }
    test = createTestClient({ mode: 'anvil', transport: http(url) })
  }, 30_000)

  afterAll(() => {
    anvil?.kill()
    process.env = savedEnv
  })

  it('discovers, makes every call inside the contract\'s deadlines, names refunds, delists a thin pool, stays inside every budget', async () => {
    const started = Date.now()
    expect(await pub.getChainId()).toBe(CHAIN_ID)

    // ── accounts, all generated here ──
    const deployer = privateKeyToAccount(generatePrivateKey())
    const p1 = privateKeyToAccount(generatePrivateKey())
    const p2 = privateKeyToAccount(generatePrivateKey())
    const keeperKey = generatePrivateKey()
    const keeperAddr = privateKeyToAccount(keeperKey).address
    const treasury = privateKeyToAccount(generatePrivateKey()).address
    for (const a of [deployer.address, p1.address, p2.address, keeperAddr]) {
      await test.setBalance({ address: a, value: 100n * ETH })
    }
    const local = defineChain({ id: CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } })
    const walletOf = (a: PrivateKeyAccount) => createWalletClient({ account: a, transport: http(url), chain: local })
    const dep = walletOf(deployer)
    const mined = async (hash: Hex) => {
      const r = await pub.waitForTransactionReceipt({ hash })
      if (r.status !== 'success') throw new Error(`tx reverted: ${hash}`)
      return r
    }
    const deploy = async (path: string, args: unknown[] = []) => {
      const a = artifact(path)
      const r = await mined(await dep.deployContract({ abi: a.abi, bytecode: a.bytecode, args } as any))
      return { address: r.contractAddress as Address, abi: a.abi, block: r.blockNumber }
    }
    const send = async (w: ReturnType<typeof walletOf>, address: Address, abi: any, functionName: string, args: unknown[] = []) =>
      mined(await w.writeContract({ address, abi, functionName, args } as any))
    const read = <R>(address: Address, abi: any, functionName: string, args: unknown[] = []) =>
      pub.readContract({ address, abi, functionName, args } as any) as Promise<R>
    const now = async () => Number((await pub.getBlock({ blockTag: 'latest' })).timestamp)
    const blockTime = async (hash: Hex) => Number((await pub.getBlock({ blockNumber: (await pub.getTransactionReceipt({ hash })).blockNumber })).timestamp)
    const warp = async (ts: number) => {
      await test.setNextBlockTimestamp({ timestamp: BigInt(ts) })
      await test.mine({ blocks: 1 })
    }

    // ── the stack, as PoolRoundTestBase.setUp builds it ──
    const weth = await deploy('MockWETH.sol/MockWETH.json')
    const v3 = await deploy('MockUniswapV3Factory.sol/MockUniswapV3Factory.json')
    const BIG_ALLOWANCE = 10n ** 16n // the contract's ceiling: 10 M gas at 1 gwei
    const rounds = await deploy('PoolRounds.sol/PoolRounds.json', [{
      weth: weth.address,
      v3Factory: v3.address,
      referralRegistry: '0x0000000000000000000000000000000000000000',
      treasury,
      maxSideRatio: 1n,
      strikePause: 300n,
      strikeWindow: 300n,
      depthPerBank: 2500n,
      minStake: 10n ** 15n,
      maxStake: 100n * ETH,
      minBank: 2n * 10n ** 16n,
      costAllowance: BIG_ALLOWANCE,
    }])
    await send(dep, rounds.address, rounds.abi, 'setDuration', [T, true])
    const ring = Number(await read<bigint>(rounds.address, rounds.abi, 'minCardinality'))
    const t0 = await now()
    const pools: Address[] = []
    for (let i = 0; i < 5; i++) {
      const token = getAddress(`0x${keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }], ['token', BigInt(i)])).slice(26)}`)
      const pool = await deploy('PoolRoundMockPool.sol/PoolRoundMockPool.json', [token, weth.address, 3000])
      await send(dep, pool.address, POOL_ADMIN_ABI, 'pushTick', [t0 - 7200, 0])
      await send(dep, pool.address, POOL_ADMIN_ABI, 'setCardinality', [ring, ring])
      await send(dep, pool.address, POOL_ADMIN_ABI, 'setLiquidity', [POOL_LIQUIDITY])
      await send(dep, v3.address, v3.abi, 'register', [token, weth.address, 3000, pool.address])
      await send(dep, rounds.address, rounds.abi, 'listPool', [pool.address])
      pools.push(pool.address)
    }
    const [poolA, poolB, poolC, poolD, poolE] = pools
    const gate = await read<bigint>(rounds.address, rounds.abi, 'gateDepth')
    say(`deployed PoolRounds ${rounds.address} at block ${rounds.block}, minCardinality ${ring}, gateDepth ${gate}, 5 pools listed through the gate`)

    // ── the keeper, wired as rounds/index.ts wires it, minus Redis ──
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('refusing a non-local RPC')
    process.env.CHAIN_PROFILE = 'rhc'
    delete process.env.CHAIN_ID
    process.env.RHC_RPC_URL = url
    process.env.KEEPER_PRIVATE_KEY = keeperKey
    const { CHAIN_PROFILE } = await import('../chainProfile.js')
    expect(CHAIN_PROFILE.rpcUrl).toBe(url)
    expect(CHAIN_PROFILE.chain.id).toBe(CHAIN_ID)
    const { getKeeperWalletClient, sendKeeperTx } = await import('../keeper/keeperWallet.js')
    const { readRoundsConfig } = await import('./config.js')
    const { createViemRoundsChain } = await import('./chain.js')
    const { MemoryRoundsStore, ROUNDS_STATE_KEY } = await import('./store.js')
    const { createRoundsKeeper } = await import('./keeper.js')
    const { evaluateRoundsHealth } = await import('./health.js')
    const cfg = readRoundsConfig({
      ROUNDS_ENABLED: 'true',
      ROUNDS_ADDRESS: rounds.address,
      ROUNDS_START_BLOCK: rounds.block.toString(),
      ROUNDS_FEES_WITHDRAW_MIN_ETH: '0.01',
      ROUNDS_INTERVAL_MS: '10000',
      ROUNDS_POOL_CHECK_SEC: '30',
    })
    if (!cfg.enabled) throw new Error('config not enabled')
    const wallet = getKeeperWalletClient()!
    expect(wallet.account.address).toBe(keeperAddr)
    const store = new MemoryRoundsStore()
    const records: Array<{ gasUsed: bigint; price: bigint; priority: string }> = []
    const keeper = createRoundsKeeper({
      chain: createViemRoundsChain({ publicClient: createPublicClient({ chain: CHAIN_PROFILE.chain, transport: http(url) }) as PublicClient, wallet: wallet as any, address: rounds.address }),
      store,
      sendTx: sendKeeperTx,
      gasGuard: {
        check: async () => null,
        record: async (r, priority) => { records.push({ gasUsed: r.gasUsed, price: r.effectiveGasPrice, priority }) },
      },
      config: cfg.config,
      log: {
        info: (m) => { keeperLog.push(m); say(`keeper: ${m}`) },
        warn: (m) => { keeperLog.push(m); say(`keeper warn: ${m}`) },
        error: (m) => { keeperLog.push(m); say(`keeper ERROR: ${m}`) },
      },
    })
    const keeperNonce = () => pub.getTransactionCount({ address: keeperAddr })
    const tickTimes: number[] = []
    const keeperTxs: Array<{ action: string; hash: Hex; gasUsed: bigint; gasLimit: bigint; costWei: bigint; maxFeePerGas: bigint }> = []
    const keeperLog: string[] = []
    const tick = async () => {
      const s = Date.now()
      const rep = await keeper.tick()
      tickTimes.push(Date.now() - s)
      for (const a of rep.actions) {
        if (a.outcome.kind === 'sent') {
          keeperTxs.push({ action: a.action, hash: a.outcome.hash, gasUsed: a.outcome.gasUsed, gasLimit: a.outcome.gasLimit, costWei: a.outcome.costWei, maxFeePerGas: a.outcome.maxFeePerGas })
        }
      }
      return rep
    }
    const health = async () => evaluateRoundsHealth(async (k) => (k === ROUNDS_STATE_KEY ? JSON.stringify(store.snapshot) : null), store.snapshot!.lastTick)

    // ── players: one bet each, no commit, no reveal ──
    const w1 = walletOf(p1)
    const w2 = walletOf(p2)
    for (const w of [w1, w2]) {
      await send(w, weth.address, weth.abi, 'mint', [w.account!.address, 10n * ETH])
      await send(w, weth.address, weth.abi, 'approve', [rounds.address, 2n ** 256n - 1n])
    }
    const UP = 1
    const DOWN = 2
    const bet = (w: ReturnType<typeof walletOf>, id: bigint, stake: bigint, side: number) =>
      send(w, rounds.address, rounds.abi, 'bet', [id, stake, side, '0x0000000000000000000000000000000000000000'])

    // ── one window, five rounds ──
    const openAt = (Math.floor((await now()) / T) + 1) * T
    await warp(openAt)
    const k = BigInt(openAt / T)
    const idOf = (pool: Address) => read<bigint>(rounds.address, rounds.abi, 'roundIdOf', [pool, T, k])
    const [A, B, C, D, E] = await Promise.all([poolA, poolB, poolC, poolD, poolE].map(idOf))
    const stake = 12n * 10n ** 17n // 1.2 ETH a side: bank 2.4, 1% kept (0.0216) covers 2 x 0.01

    // A: the ordinary round. D: activated, its pool will stop answering observe().
    // E: activated, its pool thins out before the strike window. C: one side only.
    await bet(w1, A, stake, UP); await bet(w2, A, stake, DOWN)
    await bet(w1, D, stake, UP); await bet(w2, D, stake, DOWN)
    await bet(w1, E, stake, UP); await bet(w2, E, stake, DOWN)
    await bet(w1, C, stake, UP)
    // B: activated, but opened under the contract's floor allowance, 2e13 wei:
    // 1 000 000 gas at 0.00002 gwei. On this node gas costs ~1 gwei, so no
    // keeper call on B can ever fit inside its own allowance.
    await send(dep, rounds.address, rounds.abi, 'setCostAllowance', [2n * 10n ** 13n])
    await bet(w1, B, 5n * 10n ** 17n, UP); await bet(w2, B, 5n * 10n ** 17n, DOWN)
    await send(dep, rounds.address, rounds.abi, 'setCostAllowance', [BIG_ALLOWANCE])

    const times = await read<any>(rounds.address, rounds.abi, 'roundTimes', [A])
    const [closeAt, strikeStart, strikeEnd, settleAt] = [times.closeAt, times.strikeStart, times.strikeEnd, times.settleAt].map(Number)
    const [fixStrikeBy, settleBy] = (await read<readonly [bigint, bigint]>(rounds.address, rounds.abi, 'keeperDeadlines', [A])).map(Number)
    say(`round times: closeAt ${closeAt}, strikeStart +${strikeStart - closeAt}, strikeEnd +${strikeEnd - closeAt}, settleAt +${settleAt - closeAt}; ` +
      `keeperDeadlines: fixStrike by strikeEnd + ${fixStrikeBy - strikeEnd}, settle by settleAt + ${settleBy - settleAt}`)

    let rep = await tick()
    expect(rep.discovery.caughtUp).toBe(true)
    expect(new Set(await store.openRounds())).toEqual(new Set([A, B, C, D, E]))
    expect(rep.snapshot.collecting).toBe(5)
    expect(rep.snapshot.pools).toMatchObject({ listed: 5, belowGate: [], gateDepthWei: gate.toString() })
    expect(await keeperNonce()).toBe(0)

    await warp(closeAt)
    rep = await tick()
    expect(rep.dropped).toEqual([{ roundId: C, why: 'not-activated' }])
    expect(await keeperNonce()).toBe(0)
    say('closeAt: 5 rounds discovered from events; C (one side) let go at closeAt without a transaction')

    // D's pool stops answering observe(): fixStrike and settle revert PriceUnavailableNow.
    // (Zero liquidity no longer does that: the contract reads the depth the windows had.)
    await send(dep, poolD, POOL_ADMIN_ABI, 'setForceOtherRevert', [1])
    // E's pool thins to 1 ETH before the strike window: too thin for E's bank
    // (2.4 x 2500 = 6 000 ETH needed), and below the 50 ETH listing gate.
    await send(dep, poolE, POOL_ADMIN_ABI, 'setLiquidity', [ETH])

    await warp(strikeEnd + POLL_PHASE)
    rep = await tick()
    const fix = rep.actions.find((a) => a.roundId === A)!
    expect(fix).toMatchObject({ action: 'fixStrike', outcome: { kind: 'sent', status: 'success' } })
    expect(rep.actions.find((a) => a.roundId === B)?.outcome.kind).toBe('over-budget')
    expect(rep.actions.find((a) => a.roundId === D)?.outcome).toEqual({ kind: 'sim-failed', error: 'PriceUnavailableNow' })
    expect((await read<any>(rounds.address, rounds.abi, 'roundView', [A])).strikeFixed).toBe(true)
    const fixLag = (await blockTime((fix.outcome as { hash: Hex }).hash)) - strikeEnd
    expect(strikeEnd + fixLag).toBeLessThanOrEqual(fixStrikeBy)
    say(`fixStrike(A) mined ${fixLag} s after strikeEnd (keeperDeadlines: by strikeEnd + ${fixStrikeBy - strikeEnd})`)
    // E: fixStrike reads a strike window 1 ETH deep: REFUND, reason 4, named in the log.
    expect(rep.actions.find((a) => a.roundId === E)).toMatchObject({ action: 'fixStrike', outcome: { kind: 'sent', status: 'success' } })
    const viewE = await read<any>(rounds.address, rounds.abi, 'roundView', [E])
    expect(Number(viewE.outcome)).toBe(4)
    expect(keeperLog.some((m) => /REFUND \(thin-window\)/.test(m))).toBe(true)
    // ... and the gate check found E's pool below the gate and delisted it.
    const delist = rep.actions.find((a) => a.action === 'delistIfBelowGate')!
    expect(delist.outcome).toMatchObject({ kind: 'sent', status: 'success' })
    expect((await read<readonly [boolean, boolean]>(rounds.address, rounds.abi, 'pools', [poolE]))[0]).toBe(false)
    expect(await health()).toMatchObject({ state: 'ok', warn: expect.arrayContaining(['rounds-pool-thin']) })
    say(`E: fixStrike -> REFUND (thin-window); pool E delisted by the keeper, gas ${(delist.outcome as { gasUsed: bigint }).gasUsed}`)

    // The exit window sees a higher tick from strikeEnd on: A settles UP.
    await send(dep, poolA, POOL_ADMIN_ABI, 'pushTick', [strikeEnd, 200])
    await warp(settleAt + POLL_PHASE)
    rep = await tick()
    const set = rep.actions.find((a) => a.roundId === A)!
    expect(set).toMatchObject({ action: 'settle', outcome: { kind: 'sent', status: 'success' } })
    expect(rep.dropped).toContainEqual({ roundId: A, why: 'settled' })
    expect(Number((await read<any>(rounds.address, rounds.abi, 'roundView', [A])).outcome)).toBe(1) // UP
    const settleLag = (await blockTime((set.outcome as { hash: Hex }).hash)) - settleAt
    expect(settleAt + settleLag).toBeLessThanOrEqual(settleBy)
    say(`settle(A) mined ${settleLag} s after settleAt (keeperDeadlines: by settleAt + ${settleBy - settleAt}) -> UP`)
    // Fees: E's 1% (0.0216) went out on the strike tick, A's 2% less the pot (0.0432) now.
    expect(rep.actions.find((a) => a.action === 'withdrawFees')?.outcome).toMatchObject({ kind: 'sent', status: 'success' })
    const treasuryAfterA = await read<bigint>(weth.address, weth.abi, 'balanceOf', [treasury])
    expect(treasuryAfterA).toBe((2n * stake * 2n / 100n) * 9n / 10n + ((2n * stake) / 100n) * 9n / 10n)

    // A few more ticks before the 24 h mark: D keeps failing its dry run for free, B is not retried.
    const nonceBefore = await keeperNonce()
    for (const dt of [15, 600, 3600]) {
      await warp(settleAt + dt)
      rep = await tick()
    }
    expect(await keeperNonce()).toBe(nonceBefore)
    expect(rep.snapshot).toMatchObject({ awaitingSettle: 2, overBudget: 1, refunds24h: { 'thin-window': 1 } })
    // D could never be priced and B could never be paid for: both strike
    // deadlines are gone, whoever should have called, and health says so.
    expect(rep.snapshot.deadlineMissed).toBe(2)
    expect(await health()).toMatchObject({ state: 'down', code: 'rounds-deadline-missed' })

    await warp(settleAt + GRACE)
    rep = await tick()
    const graceD = rep.actions.find((a) => a.roundId === D)!
    expect(graceD).toMatchObject({ action: 'graceSettle', outcome: { kind: 'sent', status: 'success' } })
    expect(Number((await read<any>(rounds.address, rounds.abi, 'roundView', [D])).outcome)).toBe(4) // REFUND
    // B: even the 24 h settle does not fit 2e13 wei. Nothing is sent; its players can call settle themselves.
    expect(rep.actions.find((a) => a.roundId === B)?.outcome.kind).toBe('over-budget')
    expect(await store.getSpent(B)).toBe(0n)
    expect(Number((await read<any>(rounds.address, rounds.abi, 'roundView', [B])).outcome)).toBe(0)

    // ── budgets: every round's spend within its own allowance, and equal to the receipts ──
    const spentA = await store.getSpent(A)
    const spentD = await store.getSpent(D)
    const spentE = await store.getSpent(E)
    expect(spentA).toBeGreaterThan(0n)
    for (const x of [spentA, spentD, spentE]) expect(x).toBeLessThanOrEqual(BIG_ALLOWANCE)
    const roundCosts = records.filter((r) => r.priority === 'critical').map((r) => r.gasUsed * r.price)
    expect(spentA + spentD + spentE).toBe(roundCosts.reduce((a, b) => a + b, 0n))
    // fixStrike A, fixStrike E, withdrawFees, delistIfBelowGate E, settle A, withdrawFees, settle D, withdrawFees
    expect(keeperTxs.map((x) => x.action)).toEqual([
      'fixStrike', 'fixStrike', 'withdrawFees', 'delistIfBelowGate', 'settle', 'withdrawFees', 'graceSettle', 'withdrawFees',
    ])
    expect(await keeperNonce()).toBe(8)
    expect(await read<bigint>(weth.address, weth.abi, 'balanceOf', [treasury]))
      .toBe(treasuryAfterA + ((2n * stake) / 100n) * 9n / 10n)

    // B, left to its players: anyone can release it with settle (after 24 h, REFUND).
    await send(w1, rounds.address, rounds.abi, 'settle', [B])
    expect(Number((await read<any>(rounds.address, rounds.abi, 'roundView', [B])).outcome)).toBe(4)
    rep = await tick()
    expect(await store.openRounds()).toEqual([]) // B left through its RoundSettled event

    // ── the players can collect: the rounds really are final ──
    const bal = (a: Address) => read<bigint>(weth.address, weth.abi, 'balanceOf', [a])
    const b1 = await bal(p1.address)
    await send(w1, rounds.address, rounds.abi, 'claim', [A])
    expect((await bal(p1.address)) - b1).toBe(2n * stake - (2n * stake * 2n) / 100n) // bank minus 2%
    const b2 = await bal(p2.address)
    await send(w2, rounds.address, rounds.abi, 'claim', [D])
    expect((await bal(p2.address)) - b2).toBe(stake - stake / 100n) // REFUND keeps 1%
    await send(w1, rounds.address, rounds.abi, 'claim', [C])
    const b2e = await bal(p2.address)
    await send(w2, rounds.address, rounds.abi, 'claim', [E])
    expect((await bal(p2.address)) - b2e).toBe(stake - stake / 100n) // thin-window REFUND keeps 1% too

    say(`keeper transactions: ${keeperTxs.map((x) => `${x.action} gas ${x.gasUsed}/${x.gasLimit} bid ${x.maxFeePerGas} cost ${x.costWei}`).join(' | ')}`)
    say(`spent on A ${spentA} wei, on D ${spentD} wei, on E ${spentE} wei, on B 0; price seen ${records[0]?.price} wei/gas`)
    say(`ticks ${tickTimes.length}, ms each: ${tickTimes.join(', ')}; whole run ${Date.now() - started} ms`)
  }, 120_000)
})
