// Local anvil harness for the rounds screen (docs/rhc/ROUNDS-UI.md). LOCAL ONLY.
//
// Deploys the real PoolRounds from the forge build (contracts/out), with the
// stand-in WETH, v3 factory and tokens of contracts/test/mocks and the
// depth-aware pool stand-in contracts/test/PoolRoundMockPool.sol, the way
// contracts/test/PoolRoundTestBase.sol and contracts/script/DeployPoolRounds.s.sol
// do. Then it plays the other players, the pool's price and liquidity and the
// clock, so every state of the screen can be looked at.
//
// Transactions go through anvil's unlocked dev accounts (eth_sendTransaction):
// no key is read, typed or stored here. Any RPC that is not 127.0.0.1/localhost,
// or a node that is not anvil, is refused before the first request.
//
//   anvil --chain-id 46630 --block-time 1
//   node docs/rhc/measurements/rounds-ui/anvil-local.mjs deploy
//   node docs/rhc/measurements/rounds-ui/anvil-local.mjs bet --who 2 --pool PEPE --duration 300 --side down --stake 0.02
//   node docs/rhc/measurements/rounds-ui/anvil-local.mjs warp --seconds 300      (or --to <unix>)
//   node docs/rhc/measurements/rounds-ui/anvil-local.mjs tick --pool PEPE --at <unix> --tick 100   (price from then on)
//   node docs/rhc/measurements/rounds-ui/anvil-local.mjs liquidity --pool PEPE --value 60 [--at <unix>]   (WETH of depth at tick 0)
//   node docs/rhc/measurements/rounds-ui/anvil-local.mjs delist --pool WOJAK   (delistIfBelowGate, as anyone may)
//   node docs/rhc/measurements/rounds-ui/anvil-local.mjs settle --round <id>     (PoolRounds.settle, as the keeper would)
//   node docs/rhc/measurements/rounds-ui/anvil-local.mjs status [--round <id>]
//
// Chain id 46630 matches VITE_NETWORK=rhc-testnet so the site accepts the node;
// it is still only the local process on 127.0.0.1, nothing reaches Robinhood Chain.
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../../..')
const require = createRequire(resolve(ROOT, 'frontend/package.json'))
const { createPublicClient, createWalletClient, getAddress, http, parseEther, formatEther } = require('viem')

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (name, def) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : def)
const STATE = resolve(opt('state', resolve(HERE, '.anvil-state.json')))
const RPC = opt('rpc', 'http://127.0.0.1:8545')
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC)) {
  console.error(`refusing ${RPC}: this harness only talks to a local anvil`)
  process.exit(2)
}

const OUT = resolve(ROOT, 'contracts/out')
const art = (name) => {
  const a = JSON.parse(readFileSync(resolve(OUT, `${name}.sol/${name}.json`), 'utf8'))
  return { abi: a.abi, bytecode: a.bytecode.object }
}
const pub = createPublicClient({ transport: http(RPC) })
const wallet = (account) => createWalletClient({ account, transport: http(RPC) })
const load = () => JSON.parse(readFileSync(STATE, 'utf8'))
const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2))
const ZERO = '0x0000000000000000000000000000000000000000'
const SIDES = { up: 1, down: 2 }

async function guard() {
  const v = await pub.request({ method: 'web3_clientVersion' })
  if (!/anvil/i.test(v)) throw new Error(`not an anvil node: ${v}`)
}
async function deploy(name, from, ctorArgs = []) {
  const hash = await wallet(from).deployContract({ ...art(name), args: ctorArgs, account: from, chain: null })
  return getAddress((await pub.waitForTransactionReceipt({ hash })).contractAddress)
}
async function send(from, address, name, functionName, fnArgs = []) {
  const hash = await wallet(from).writeContract({ address, abi: art(name).abi, functionName, args: fnArgs, account: from, chain: null })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${functionName} reverted`)
  return r
}
const now = async () => Number((await pub.getBlock()).timestamp)
const roundIdOf = (pool, d, i) => (BigInt(pool) << 96n) | (BigInt(d) << 64n) | BigInt(i)

async function main() {
  await guard()
  if (cmd === 'deploy') {
    const chainId = await pub.getChainId()
    const accounts = await pub.request({ method: 'eth_accounts' })
    const [owner, , , , treasury, keeper] = accounts
    const startBlock = await pub.getBlockNumber()
    const t = await now()
    const weth = await deploy('MockWETH', owner)
    const factory = await deploy('MockUniswapV3Factory', owner)
    const registry = await deploy('ReferralRegistry', owner)
    // DeployPoolRounds.s.sol defaults: sides 1:1, 300 s pause and strike window, K = 2500,
    // stakes 0.005-0.04, minimum bank 0.02, cost allowance 69 692 gwei.
    const rounds = await deploy('PoolRounds', owner, [
      {
        weth,
        v3Factory: factory,
        referralRegistry: registry,
        treasury,
        maxSideRatio: 1n,
        strikePause: 300n,
        strikeWindow: 300n,
        depthPerBank: 2500n,
        minStake: parseEther('0.005'),
        maxStake: parseEther('0.04'),
        minBank: parseEther('0.02'),
        costAllowance: 69_692_000_000_000n,
      },
    ])
    await send(owner, registry, 'ReferralRegistry', 'setMarketFactory', [rounds])
    await send(owner, registry, 'ReferralRegistry', 'authorizeMarket', [rounds])
    for (const d of [300n, 900n]) await send(owner, rounds, 'PoolRounds', 'setDuration', [d, true])
    const card = Number(await pub.readContract({ address: rounds, abi: art('PoolRounds').abi, functionName: 'minCardinality' }))
    const pools = {}
    // Depth at tick 0 is the liquidity in WETH: PEPE 250 (bank up to 0.1), WOJAK 75 (up to 0.03).
    for (const [name, sym, liq] of [
      ['Pepe Test', 'PEPE', '250'],
      ['Wojak Test', 'WOJAK', '75'],
    ]) {
      const token = await deploy('MockToken', owner, [name, sym, 18])
      const pool = await deploy('PoolRoundMockPool', owner, [token, weth, 3000])
      // As PoolRoundTestBase: two hours of history at tick 0, a full ring, depth above the 50 WETH gate.
      await send(owner, pool, 'PoolRoundMockPool', 'pushTick', [t - 7200, 0])
      await send(owner, pool, 'PoolRoundMockPool', 'setCardinality', [card, card])
      await send(owner, pool, 'PoolRoundMockPool', 'setLiquidity', [parseEther(liq)])
      await send(owner, factory, 'MockUniswapV3Factory', 'register', [token, weth, 3000, pool])
      await send(owner, rounds, 'PoolRounds', 'listPool', [pool])
      pools[sym] = pool
    }
    await send(owner, rounds, 'PoolRounds', 'setPauser', [keeper])
    for (const p of accounts.slice(1, 4)) await send(owner, weth, 'MockWETH', 'mint', [p, parseEther('1')])
    const state = { rpc: RPC, chainId, rounds, weth, registry, pools, deployBlock: startBlock.toString(), accounts }
    save(state)
    console.log(JSON.stringify({ chainId, rounds, weth, pools, deployBlock: state.deployBlock, uiPlayer: accounts[1] }, null, 2))
    return
  }

  const s = load()
  const read = (fn, a = []) => pub.readContract({ address: s.rounds, abi: art('PoolRounds').abi, functionName: fn, args: a })

  if (cmd === 'bet') {
    const who = Number(opt('who', '2'))
    const player = s.accounts[who]
    const pool = s.pools[opt('pool', 'PEPE')]
    const d = Number(opt('duration', '300'))
    const side = SIDES[opt('side', 'down')]
    const stake = parseEther(opt('stake', '0.02'))
    const index = Math.floor((await now()) / d) + (args.includes('--next') ? 1 : 0)
    const roundId = roundIdOf(pool, d, index)
    await send(player, s.weth, 'MockWETH', 'approve', [s.rounds, stake])
    // PoolRounds.bet(roundId, stake, side, referrer)
    await send(player, s.rounds, 'PoolRounds', 'bet', [roundId, stake, side, ZERO])
    console.log(`account ${who} bet ${opt('side', 'down').toUpperCase()} ${formatEther(stake)} in round ${roundId}`)
  } else if (cmd === 'warp') {
    const to = opt('to')
    const delta = to ? Number(to) - (await now()) : Number(opt('seconds', '0'))
    if (delta > 0) await pub.request({ method: 'evm_increaseTime', params: [delta] })
    await pub.request({ method: 'evm_mine', params: [] })
    console.log(`chain time now ${await now()}`)
  } else if (cmd === 'tick') {
    await send(s.accounts[0], s.pools[opt('pool', 'PEPE')], 'PoolRoundMockPool', 'pushTick', [Number(opt('at')), Number(opt('tick', '0'))])
    console.log('tick pushed')
  } else if (cmd === 'liquidity') {
    const pool = s.pools[opt('pool', 'PEPE')]
    const value = parseEther(opt('value', '250'))
    const at = opt('at')
    if (at) await send(s.accounts[0], pool, 'PoolRoundMockPool', 'pushLiquidity', [Number(at), value])
    else await send(s.accounts[0], pool, 'PoolRoundMockPool', 'setLiquidity', [value])
    console.log(`liquidity ${opt('value', '250')} ${at ? 'from ' + at : 'now'}; maxBankOf ${formatEther(await read('maxBankOf', [pool]))}`)
  } else if (cmd === 'delist') {
    await send(s.accounts[6], s.rounds, 'PoolRounds', 'delistIfBelowGate', [s.pools[opt('pool', 'WOJAK')]])
    console.log('delisted')
  } else if (cmd === 'settle') {
    const roundId = BigInt(opt('round'))
    await send(s.accounts[5], s.rounds, 'PoolRounds', 'settle', [roundId])
    const v = await read('roundView', [roundId])
    console.log(`settled ${roundId}: outcome ${v.outcome} (1 UP, 2 DOWN, 3 TIE, 4 REFUND)`)
  } else if (cmd === 'status') {
    console.log(`chain time ${await now()}`)
    const r = opt('round')
    if (r) console.log(JSON.stringify(await read('roundView', [BigInt(r)]), (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2))
  } else {
    console.error('commands: deploy | bet | warp | tick | liquidity | delist | settle | status')
    process.exit(2)
  }
}

if (!existsSync(resolve(OUT, 'PoolRounds.sol/PoolRounds.json'))) {
  console.error('contracts/out is missing: run forge build in contracts/ first')
  process.exit(2)
}
main().catch((e) => {
  console.error(e?.shortMessage || e?.message || e)
  process.exit(1)
})
