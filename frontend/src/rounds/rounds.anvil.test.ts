// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPublicClient, createWalletClient, getAddress, http, parseEther, type Abi, type Address, type Hex, type PublicClient } from 'viem'
import { createRoundsClient, OUTCOME_REFUND, OUTCOME_UP, REASON_THIN, TICKET_PLACED, type RoundsClient } from './roundsClient'
import { acceptedOf, depthAllows, largestStakeWithinDepth, payoutIfWin, roundIdOf, roundTimes, SIDE_DOWN, SIDE_UP } from './roundMath'
import { describeTicket, refundReasonText } from './ticketState'
import { explainRoundError } from './roundErrors'

/**
 * The screen's RoundsClient adapter and its pure logic against the real
 * PoolRounds (contracts/out, interface v3), deployed with the stand-in WETH and
 * v3 factory of contracts/test/mocks and the depth-aware pool stand-in
 * contracts/test/PoolRoundMockPool.sol, as PoolRoundTestBase does, on a
 * LOCAL anvil node. Opt-in; it warps that node's clock, so give it its own:
 *
 *   anvil --port 8546 --chain-id 46630
 *   (cmd)  set ROUNDS_ANVIL_RPC=http://127.0.0.1:8546 && npx vitest run src/rounds/rounds.anvil.test.ts
 *
 * Uses anvil's unlocked dev accounts through eth_sendTransaction: no key
 * appears here. Anything but 127.0.0.1 / localhost is refused before a request.
 */
const RPC = process.env.ROUNDS_ANVIL_RPC ?? ''
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC)
const OUT = resolve(process.cwd(), '../contracts/out')
const RUN = LOCAL && existsSync(resolve(OUT, 'PoolRounds.sol/PoolRounds.json'))

function art(name: string): { abi: Abi; bytecode: Hex } {
  const a = JSON.parse(readFileSync(resolve(OUT, `${name}.sol/${name}.json`), 'utf8'))
  return { abi: a.abi, bytecode: a.bytecode.object }
}
const ZERO: Address = '0x0000000000000000000000000000000000000000'

describe.skipIf(!RUN)('RoundsClient against PoolRounds on local anvil', () => {
  let pub: PublicClient
  let accounts: Address[]
  let rounds: Address
  let weth: Address
  let pool: Address
  let rc: RoundsClient
  const wallet = (account: Address) => createWalletClient({ account, transport: http(RPC) })

  async function deploy(name: string, from: Address, args: unknown[] = []) {
    const hash = await wallet(from).deployContract({ ...art(name), args, account: from, chain: null })
    return getAddress((await pub.waitForTransactionReceipt({ hash })).contractAddress as Address)
  }
  async function send(from: Address, req: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }) {
    const hash = await wallet(from).writeContract({ ...req, account: from, chain: null } as never)
    const r = await pub.waitForTransactionReceipt({ hash })
    if (r.status !== 'success') throw new Error(`${req.functionName} reverted`)
  }
  const call = (from: Address, address: Address, name: string, functionName: string, args: readonly unknown[] = []) =>
    send(from, { address, abi: art(name).abi, functionName, args })
  async function setTime(ts: number) {
    await pub.request({ method: 'evm_setNextBlockTimestamp' as never, params: [ts] as never })
    await pub.request({ method: 'evm_mine' as never, params: [] as never })
  }
  const balance = (who: Address) => pub.readContract({ address: weth, abi: art('MockWETH').abi, functionName: 'balanceOf', args: [who] }) as Promise<bigint>

  beforeAll(async () => {
    pub = createPublicClient({ transport: http(RPC) })
    if (!/anvil/i.test((await pub.request({ method: 'web3_clientVersion' as never })) as string)) throw new Error('not anvil')
    accounts = (await pub.request({ method: 'eth_accounts' as never })) as Address[]
    const [owner, , , , treasury] = accounts
    const now = Number((await pub.getBlock()).timestamp)
    weth = await deploy('MockWETH', owner)
    const factory = await deploy('MockUniswapV3Factory', owner)
    const registry = await deploy('ReferralRegistry', owner)
    // DeployPoolRounds.s.sol defaults: 1:1, 300 s pause and window, 0.005-0.04, bank 0.02, 69 692 gwei.
    rounds = await deploy('PoolRounds', owner, [
      {
        weth, v3Factory: factory, referralRegistry: registry, treasury, maxSideRatio: 1n, strikePause: 300n, strikeWindow: 300n, depthPerBank: 2500n,
        minStake: parseEther('0.005'), maxStake: parseEther('0.04'), minBank: parseEther('0.02'), costAllowance: 69_692_000_000_000n,
      },
    ])
    await call(owner, registry, 'ReferralRegistry', 'setMarketFactory', [rounds])
    await call(owner, registry, 'ReferralRegistry', 'authorizeMarket', [rounds])
    await call(owner, rounds, 'PoolRounds', 'setDuration', [300n, true])
    const token = await deploy('MockToken', owner, ['Pepe Test', 'PEPE', 18])
    // PoolRoundMockPool: the stand-in with a history of liquidity, which the depth rule reads.
    pool = await deploy('PoolRoundMockPool', owner, [token, weth, 3000])
    const card = (await pub.readContract({ address: rounds, abi: art('PoolRounds').abi, functionName: 'minCardinality' })) as bigint
    await call(owner, pool, 'PoolRoundMockPool', 'pushTick', [now - 7200, 0])
    await call(owner, pool, 'PoolRoundMockPool', 'setCardinality', [Number(card), Number(card)])
    // 250 WETH of depth at tick 0: above the 50 WETH gate, rounds up to a 0.1 bank.
    await call(owner, pool, 'PoolRoundMockPool', 'setLiquidity', [parseEther('250')])
    await call(owner, factory, 'MockUniswapV3Factory', 'register', [token, weth, 3000, pool])
    await call(owner, rounds, 'PoolRounds', 'listPool', [pool])
    for (const p of accounts.slice(1, 4)) {
      await call(owner, weth, 'MockWETH', 'mint', [p, parseEther('1')])
      await call(p, weth, 'MockWETH', 'approve', [rounds, parseEther('1')])
    }
    rc = createRoundsClient(pub, rounds, 0n)
  }, 60_000)

  it('reads constants and the switched-on pools and durations', async () => {
    const c = await rc.constants()
    expect(c).toMatchObject({ weth, minStake: parseEther('0.005'), maxStake: parseEther('0.04'), strikePause: 300, strikeWindow: 300, normalFeeBps: 200, voidFeeBps: 100, chainSideRatio: 1 })
    const m = await rc.markets([], [300, 900])
    expect(m.pools).toEqual([{ pool, wethIsToken0: false }])
    expect(m.durations).toEqual([300])
  })

  it('bets in the open, estimates the part that plays, settles from the pool, and collects what previewClaim promised', async () => {
    const [, alice, bob, carol] = accounts
    const index = BigInt(Math.floor(Number((await pub.getBlock()).timestamp) / 300)) + 1n
    const roundId = roundIdOf(pool, 300, index)
    const t = roundTimes(300, index, 300, 300)
    await setTime(t.openAt + 5)
    await send(alice, rc.betRequest(roundId, SIDE_UP, parseEther('0.02'), ZERO))
    await send(bob, rc.betRequest(roundId, SIDE_DOWN, parseEther('0.01'), ZERO))
    await send(carol, rc.betRequest(roundId, SIDE_UP, parseEther('0.01'), ZERO))

    const open = await rc.round(roundId)
    expect(open.times).toEqual(t) // the contract's roundTimes and the screen's layout agree
    expect(open).toMatchObject({ up: parseEther('0.03'), down: parseEther('0.01'), acceptedUp: parseEther('0.01'), acceptedDown: parseEther('0.01'), bookFinal: false })
    expect((await rc.history(alice)).roundIds).toContain(roundId)
    const ticket = await rc.ticket(roundId, alice)
    expect(ticket).toEqual({ stake: parseEther('0.02'), side: SIDE_UP, status: TICKET_PLACED })

    // A second bet from the same wallet, and a bet after the close, are refused in plain words.
    await expect(pub.simulateContract({ ...rc.betRequest(roundId, SIDE_DOWN, parseEther('0.01'), ZERO), account: alice } as never)).rejects.toSatisfy(
      (e: unknown) => /one per wallet per round/.test(explainRoundError(e)),
    )
    await setTime(t.closeAt)
    await expect(pub.simulateContract({ ...rc.betRequest(roundId, SIDE_UP, parseEther('0.01'), ZERO), account: accounts[4] } as never)).rejects.toSatisfy(
      (e: unknown) => /Bets on this round are closed/.test(explainRoundError(e)),
    )
    const closed = await rc.round(roundId)
    expect(closed).toMatchObject({ bookFinal: true, activated: true })
    const at = (now: number, extra: object = {}) =>
      describeTicket({ times: t, now, status: ticket.status, stake: ticket.stake, side: ticket.side, up: closed.up, down: closed.down, bookFinal: true, activated: true, outcome: 0, ...extra })
    expect(at(t.closeAt).kind).toBe('pause')
    expect(at(t.strikeStart).kind).toBe('strike')

    // The pool moves up from the end of the strike window; anyone settles at settleAt.
    await call(accounts[0], pool, 'PoolRoundMockPool', 'pushTick', [t.strikeEnd, 100])
    await setTime(t.settleAt)
    await call(accounts[5], rounds, 'PoolRounds', 'settle', [roundId])
    const settled = await rc.round(roundId)
    expect(settled.outcome).toBe(OUTCOME_UP)
    const expected = acceptedOf(ticket.stake, SIDE_UP, settled.up, settled.down)
    const preview = await rc.previewClaim(roundId, alice)
    expect(preview).toBe(payoutIfWin(expected.accepted, expected.returned, 200))
    expect(at(t.settleAt, { outcome: settled.outcome, previewPayout: preview })).toMatchObject({ kind: 'claimable', won: true })
    expect(await rc.previewClaim(roundId, bob)).toBe(0n) // fully matched and lost

    const before = await balance(alice)
    await send(alice, rc.claimRequest(roundId))
    expect((await balance(alice)) - before).toBe(preview)
    expect((await rc.history(alice)).claimed.get(roundId.toString())).toBe(preview)
  }, 120_000)

  it('returns the whole stake of a round that does not play, from the close on', async () => {
    const [, alice] = accounts
    const index = BigInt(Math.floor(Number((await pub.getBlock()).timestamp) / 300)) + 1n
    const roundId = roundIdOf(pool, 300, index)
    const t = roundTimes(300, index, 300, 300)
    await setTime(t.openAt + 1)
    await send(alice, rc.betRequest(roundId, SIDE_DOWN, parseEther('0.005'), ZERO))
    expect(await rc.previewClaim(roundId, alice)).toBeUndefined() // before the close it reverts
    await setTime(t.closeAt)
    const r = await rc.round(roundId)
    expect(r).toMatchObject({ bookFinal: true, activated: false })
    const preview = await rc.previewClaim(roundId, alice)
    expect(preview).toBe(parseEther('0.005'))
    expect(
      describeTicket({ times: t, now: t.closeAt, status: 1, stake: parseEther('0.005'), side: SIDE_DOWN, up: r.up, down: r.down, bookFinal: true, activated: false, outcome: 0, previewPayout: preview }),
    ).toMatchObject({ kind: 'refund', action: 'claim' })
  }, 60_000)

  it('refunds a round whose strike window was thinner than its bank needs (reason 4), keeping 1%', async () => {
    const [owner, alice, bob] = accounts
    const index = BigInt(Math.floor(Number((await pub.getBlock()).timestamp) / 300)) + 1n
    const roundId = roundIdOf(pool, 300, index)
    const t = roundTimes(300, index, 300, 300)
    await setTime(t.openAt + 1)
    await send(alice, rc.betRequest(roundId, SIDE_UP, parseEther('0.02'), ZERO))
    await send(bob, rc.betRequest(roundId, SIDE_DOWN, parseEther('0.02'), ZERO))
    // Bank 0.04 needs 0.04 x 2500 = 100 WETH in each window; the strike window gets 60.
    await call(owner, pool, 'PoolRoundMockPool', 'pushLiquidity', [t.strikeStart, parseEther('60')])
    await call(owner, pool, 'PoolRoundMockPool', 'pushLiquidity', [t.settleAt + 1, parseEther('250')])
    await setTime(t.settleAt)
    await call(accounts[5], rounds, 'PoolRounds', 'settle', [roundId])
    const r = await rc.round(roundId)
    expect(r.outcome).toBe(OUTCOME_REFUND)
    expect(await rc.settleReason(roundId)).toBe(REASON_THIN)
    const preview = await rc.previewClaim(roundId, alice)
    expect(preview).toBe(parseEther('0.0198')) // the matched 0.02 minus 1%
    expect(refundReasonText(REASON_THIN, '1%')).toMatch(/too little liquidity during the strike or exit window/)
  }, 60_000)

  it('refuses a bet that raises the bank past the pool depth, lets the bigger side in, and stops a pool below the gate', async () => {
    const [owner, alice, bob, carol] = accounts
    const index = BigInt(Math.floor(Number((await pub.getBlock()).timestamp) / 300)) + 1n
    const roundId = roundIdOf(pool, 300, index)
    const t = roundTimes(300, index, 300, 300)
    await setTime(t.openAt + 1)
    await call(owner, pool, 'PoolRoundMockPool', 'setLiquidity', [parseEther('60')]) // about 60 WETH of depth, maxBank about 0.024
    const d = await rc.poolDepth(pool)
    const onChain = (await pub.readContract({ address: rounds, abi: art('PoolRounds').abi, functionName: 'wethDepth', args: [pool] })) as bigint
    expect(d).toEqual({ depth: onChain, maxBank: onChain / 2500n })
    expect(d.maxBank > parseEther('0.02') && d.maxBank < parseEther('0.04')).toBe(true)
    await send(alice, rc.betRequest(roundId, SIDE_UP, parseEther('0.02'), ZERO))
    // DOWN 0.02 would make the bank 0.04 > 0.024: refused, and the screen's own check agrees.
    expect(depthAllows(parseEther('0.02'), 0n, SIDE_DOWN, parseEther('0.02'), d.maxBank)).toBe(false)
    await expect(pub.simulateContract({ ...rc.betRequest(roundId, SIDE_DOWN, parseEther('0.02'), ZERO), account: bob } as never)).rejects.toSatisfy(
      (e: unknown) => /The pool's depth limits this round's bank/.test(explainRoundError(e)),
    )
    expect(largestStakeWithinDepth(parseEther('0.02'), 0n, SIDE_DOWN, d.maxBank, parseEther('0.04'))).toBe(d.maxBank / 2n)
    await send(bob, rc.betRequest(roundId, SIDE_DOWN, parseEther('0.01'), ZERO))
    await send(carol, rc.betRequest(roundId, SIDE_UP, parseEther('0.04'), ZERO)) // bigger side: not limited

    // Below the gate: no bets, anyone can delist, the pool leaves the list, the bet can still be collected.
    await call(owner, pool, 'PoolRoundMockPool', 'setLiquidity', [parseEther('40')])
    await expect(pub.simulateContract({ ...rc.betRequest(roundId, SIDE_DOWN, parseEther('0.005'), ZERO), account: accounts[4] } as never)).rejects.toSatisfy(
      (e: unknown) => /too little WETH right now to take bets/.test(explainRoundError(e)),
    )
    await call(accounts[6], rounds, 'PoolRounds', 'delistIfBelowGate', [pool])
    expect((await rc.markets([pool], [300])).pools).toEqual([])
    await setTime(t.settleAt)
    await call(accounts[5], rounds, 'PoolRounds', 'settle', [roundId])
    const preview = await rc.previewClaim(roundId, alice)
    expect(preview !== undefined && preview > 0n).toBe(true)
    const before = await balance(alice)
    await send(alice, rc.claimRequest(roundId))
    expect((await balance(alice)) - before).toBe(preview)
  }, 60_000)
})
