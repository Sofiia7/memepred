/**
 * Read-only check of the Robinhood Chain testnet (46630) before PoolRounds is deployed there:
 * do the demo stand-in pools pass PoolRounds.listPool's gate, what does the ring fix cost, what
 * gas do the keeper's pool reads cost on them today, and are the wallets of DEPLOYMENTS.md funded.
 *
 *   scripts\node_modules\.bin\tsx scripts\rhc\rounds-gate-check.mts            (cmd, from C:\Server\memepred)
 *   scripts\node_modules\.bin\tsx scripts\rhc\rounds-gate-check.mts --json     machine-readable
 *
 * NOTHING IS SENT. The only RPC methods this file can issue are eth_chainId, eth_call,
 * eth_getBalance and eth_getLogs (a whitelist in rpc() below), paced to at most one request every
 * 600 ms, no subscriptions. It reads no .env and no key file: every address is a public one from
 * docs/rhc/DEPLOYMENTS.md.
 *
 * How the gate is checked without deploying anything: scripts/rhc/rounds-gate-probe.sol is compiled
 * (forge, into a temporary folder, contracts/ untouched) and run as the INIT CODE of an eth_call with
 * no `to`. The node executes that constructor on a throwaway copy of the state: it deploys a
 * ReferralRegistry and a PoolRounds with DeployPoolRounds.s.sol's default parameters, calls listPool
 * for every pool as the owner would, tries the stand-in fixes anyone may make (the ring with
 * setCardinality, then the depth with setLiquidity) with listPool after each, checks whether the pool
 * reports the secondsPerLiquidity that fixStrike and settle now read, and measures observe(). The
 * result comes back as the call's return data; the
 * state is discarded. The L1 part of each transaction the deployment would send is asked of the
 * chain's NodeInterface (0xC8, gasEstimateL1Component), also by eth_call.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeAbiParameters, decodeErrorResult, decodeFunctionResult, encodeAbiParameters, encodeDeployData,
  encodeFunctionData, formatEther, formatGwei, parseAbi, parseAbiParameters, type Address, type Hex,
} from 'viem'
import { deployScriptDefault, plannedGate, standinDepthEth } from './rounds-lib.mts'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolvePath(here, '../..')
const CONTRACTS = join(ROOT, 'contracts')
const FORGE = process.env.FORGE_BIN ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.foundry', 'bin', process.platform === 'win32' ? 'forge.exe' : 'forge')
const RPC = process.env.RHC_TESTNET_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com'
const JSON_OUT = process.argv.includes('--json')
const TESTNET_ID = 46630

// ── public addresses, docs/rhc/DEPLOYMENTS.md (deployment of 2026-09-29, stand-ins of 2026-09-05) ──
const WETH: Address = '0xaF3aCfCE41417DE5C973cc214E170C73480b068a'
const V3_FACTORY: Address = '0x59385Ca69a4CA9628A411a6A0655C3EaF7507316'
const POOLS: Array<[string, Address]> = [
  ['MOONCAT', '0xfC5FB7d3B1DDFFc0b50b0CDDFFe3B016d4FF57cb'],
  ['PEPE', '0xEFd4618F36268CE8c1c8Ad3783bdCa6185221dBd'],
  ['FROGGO', '0x779E9B50837478FcCD7DB50592eDB16ed45D8A18'],
  ['fixture (first stand-in, not a demo pool)', '0xC9168555E619e4E00743d5FB14CBeaA39753A450'],
]
const WALLETS: Array<[string, Address]> = [
  ['deployer (owner, treasury)', '0x12f9B9De75ccEa7be573F643A99AAA63b9448BD2'],
  ['keeper', '0xbFa008e5A8d46d2014b83551ce6209108416eea4'],
  ['multisig stub (EOA)', '0xAA1a14ad2f57fc79Ac14b2Cf5e2968Fdaeb9047F'],
]
const ARB_GAS_INFO: Address = '0x000000000000000000000000000000000000006C'
const ARB_SYS: Address = '0x0000000000000000000000000000000000000064'
const NODE_INTERFACE: Address = '0x00000000000000000000000000000000000000C8'

// ── the one door to the network ─────────────────────────────────────────
const ALLOWED = new Set(['eth_chainId', 'eth_call', 'eth_getBalance', 'eth_getLogs'])
const GAP_MS = 600
let lastAt = 0
let requests = 0
async function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  if (!ALLOWED.has(method)) throw new Error(`refusing ${method}: this script only reads`)
  for (let attempt = 0; ; attempt++) {
    const wait = lastAt + GAP_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastAt = Date.now()
    requests++
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requests, method, params }),
      signal: AbortSignal.timeout(60_000),
    })
    if (res.status === 429 && attempt < 2) { lastAt = Date.now() + 5_000; continue }
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
    const body = await res.json() as { result?: T; error?: { message?: string; data?: unknown } }
    if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`)
    return body.result as T
  }
}
const call = (to: Address | null, data: Hex, gas?: bigint) =>
  rpc<Hex>('eth_call', [{ ...(to ? { to } : {}), data, ...(gas ? { gas: `0x${gas.toString(16)}` } : {}) }, 'latest'])

// ── artifacts ───────────────────────────────────────────────────────────
function artifact(path: string) {
  const j = JSON.parse(readFileSync(path, 'utf8'))
  return { abi: j.abi, bytecode: j.bytecode.object as Hex }
}

function buildProbe(): Hex {
  const out = join(tmpdir(), 'rounds-gate-probe')
  mkdirSync(out, { recursive: true })
  // Separate out and cache folders: nothing under contracts/ is written.
  execFileSync(FORGE, ['build', '../scripts/rhc/rounds-gate-probe.sol', '--out', join(out, 'out'), '--cache-path', join(out, 'cache')], {
    cwd: CONTRACTS, stdio: ['ignore', 'ignore', 'inherit'],
  })
  return artifact(join(out, 'out', 'rounds-gate-probe.sol', 'RoundsGateProbe.json')).bytecode
}

const POOL_RESULT = 'address pool,address token0,address token1,uint24 fee,bool wethIsToken0,bool isWethPool,bool canonical,uint256 liquidity,int24 tick,uint16 cardinality,uint16 cardinalityNext,uint256 depth,uint256 gateDepth,bool canServeWindow,uint256 segments,uint32 firstSegmentTs,uint32 lastSegmentTs,bool listedAsIs,bytes listErrorAsIs,uint256 listGasAsIs,bool growOk,uint256 growGas,uint16 cardinalityAfterGrow,bool listedAfterGrow,bytes listErrorAfterGrow,uint256 listGasAfterGrow,bool deepenOk,uint256 depthAfterDeepen,bool listedAfterDeepen,bytes listErrorAfterDeepen,uint256 splDelta,uint256 windowDepth,uint256 observe2Gas,uint256 observe3Gas,uint256 observe5Gas'
const RESULT = parseAbiParameters(`(uint256 chainId,uint256 blockNumber,uint256 timestamp,uint256 registryDeployGas,uint256 roundsDeployGas,uint256 wireGas,uint256 minCardinality,address rounds,(${POOL_RESULT})[] pools)`)

const ARB_ABI = parseAbi([
  'function getPricesInWei() view returns (uint256,uint256,uint256,uint256,uint256,uint256)',
  'function getMinimumGasPrice() view returns (uint256)',
  'function getL1BaseFeeEstimate() view returns (uint256)',
])
const ARB_SYS_ABI = parseAbi(['function arbBlockNumber() view returns (uint256)'])
const NODE_ABI = parseAbi([
  'function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)',
])
const CALLS_ABI = parseAbi([
  'function setMarketFactory(address)',
  'function authorizeMarket(address)',
  'function setDuration(uint256,bool)',
  'function setPauser(address)',
  'function listPool(address)',
  'function setCardinality(uint16,uint16)',
  'function fixStrike(uint256)',
  'function settle(uint256)',
  'function withdrawFees()',
  'function bet(uint256,uint256,uint8,address)',
  'function claim(uint256)',
])

function errorName(roundsAbi: any, data: Hex): string {
  if (!data || data === '0x') return 'revert without data'
  try {
    const e = decodeErrorResult({ abi: roundsAbi, data })
    return `${e.errorName}(${(e.args ?? []).map(String).join(', ')})`
  } catch {
    return `undecoded ${data.slice(0, 10)}`
  }
}

async function main() {
  const lines: string[] = []
  const say = (s = '') => { lines.push(s); if (!JSON_OUT) console.log(s) }

  const chainId = Number(BigInt(await rpc<Hex>('eth_chainId', [])))
  if (chainId !== TESTNET_ID) throw new Error(`chain ${chainId} is not the testnet ${TESTNET_ID}: refusing`)

  const rounds = artifact(join(CONTRACTS, 'out', 'PoolRounds.sol', 'PoolRounds.json'))
  const registry = artifact(join(CONTRACTS, 'out', 'ReferralRegistry.sol', 'ReferralRegistry.json'))
  const probeCode = buildProbe()
  // DeployPoolRounds.s.sol's defaults and the depth new stand-ins get, read from the sources (rounds-lib.mts).
  const d = (k: string) => deployScriptDefault(k)
  const gate = plannedGate()
  const cfg = [d('ROUNDS_MAX_SIDE_RATIO'), d('ROUNDS_STRIKE_PAUSE'), d('ROUNDS_STRIKE_WINDOW'), d('ROUNDS_DEPTH_PER_BANK'), d('ROUNDS_MIN_STAKE'), d('ROUNDS_MAX_STAKE'), d('ROUNDS_MIN_BANK'), d('ROUNDS_COST_ALLOWANCE'), standinDepthEth(gate.gateDepth) * 10n ** 18n] as const
  const probeData = (probeCode + encodeAbiParameters(parseAbiParameters('address,address,address[],uint256[9]'), [WETH, V3_FACTORY, POOLS.map((p) => p[1]), cfg]).slice(2)) as Hex

  // 1. the probe: everything the gate needs, on today's state, in one eth_call
  const raw = await call(null, probeData, 30_000_000n)
  const [r] = decodeAbiParameters(RESULT, raw) as any

  // block.number inside an Arbitrum eth_call is the parent chain's block; the chain's own is ArbSys's.
  const l2Block = decodeFunctionResult({ abi: ARB_SYS_ABI, functionName: 'arbBlockNumber', data: await call(ARB_SYS, encodeFunctionData({ abi: ARB_SYS_ABI, functionName: 'arbBlockNumber' })) }) as bigint

  // 2. gas prices (ArbGasInfo)
  const prices = decodeFunctionResult({ abi: ARB_ABI, functionName: 'getPricesInWei', data: await call(ARB_GAS_INFO, encodeFunctionData({ abi: ARB_ABI, functionName: 'getPricesInWei' })) }) as readonly bigint[]
  const minPrice = decodeFunctionResult({ abi: ARB_ABI, functionName: 'getMinimumGasPrice', data: await call(ARB_GAS_INFO, encodeFunctionData({ abi: ARB_ABI, functionName: 'getMinimumGasPrice' })) }) as bigint
  const l2Price = prices[5]

  // 3. the L1 part of each transaction of the deployment and of one round (NodeInterface)
  const zero = '0x0000000000000000000000000000000000000000' as Address
  const someone = '0x000000000000000000000000000000000000dEaD' as Address
  const deployRounds = encodeDeployData({
    abi: rounds.abi, bytecode: rounds.bytecode,
    args: [{ weth: WETH, v3Factory: V3_FACTORY, referralRegistry: someone, treasury: someone, maxSideRatio: cfg[0], strikePause: cfg[1], strikeWindow: cfg[2], depthPerBank: cfg[3], minStake: cfg[4], maxStake: cfg[5], minBank: cfg[6], costAllowance: cfg[7] }],
  })
  const roundId = (BigInt(POOLS[0][1]) << 96n) | (300n << 64n) | 5_000_000n
  const txs: Array<[string, boolean, Address, Hex]> = [
    ['deploy ReferralRegistry', true, zero, registry.bytecode],
    ['deploy PoolRounds', true, zero, deployRounds],
    ['setMarketFactory', false, someone, encodeFunctionData({ abi: CALLS_ABI, functionName: 'setMarketFactory', args: [someone] })],
    ['authorizeMarket', false, someone, encodeFunctionData({ abi: CALLS_ABI, functionName: 'authorizeMarket', args: [someone] })],
    ['setDuration', false, someone, encodeFunctionData({ abi: CALLS_ABI, functionName: 'setDuration', args: [300n, true] })],
    ['listPool', false, someone, encodeFunctionData({ abi: CALLS_ABI, functionName: 'listPool', args: [POOLS[0][1]] })],
    ['setPauser', false, someone, encodeFunctionData({ abi: CALLS_ABI, functionName: 'setPauser', args: [someone] })],
    ['setCardinality (ring fix)', false, POOLS[0][1], encodeFunctionData({ abi: CALLS_ABI, functionName: 'setCardinality', args: [gate.minCardinality, gate.minCardinality] })],
    ['fixStrike', false, someone, encodeFunctionData({ abi: CALLS_ABI, functionName: 'fixStrike', args: [roundId] })],
    ['settle', false, someone, encodeFunctionData({ abi: CALLS_ABI, functionName: 'settle', args: [roundId] })],
    ['withdrawFees', false, someone, encodeFunctionData({ abi: CALLS_ABI, functionName: 'withdrawFees' })],
  ]
  const l1: Record<string, bigint> = {}
  for (const [name, creation, to, data] of txs) {
    const out = decodeFunctionResult({
      abi: NODE_ABI, functionName: 'gasEstimateL1Component',
      data: await call(NODE_INTERFACE, encodeFunctionData({ abi: NODE_ABI, functionName: 'gasEstimateL1Component', args: [to, creation, data] })),
    }) as readonly [bigint, bigint, bigint]
    l1[name] = out[0]
  }

  // 4. balances of the wallets named in DEPLOYMENTS.md
  const balances: Array<[string, Address, bigint]> = []
  for (const [name, a] of WALLETS) balances.push([name, a, BigInt(await rpc<Hex>('eth_getBalance', [a, 'latest']))])

  if (JSON_OUT) {
    console.log(JSON.stringify({ chainId, rpc: RPC, requests, l2Block: String(l2Block), probe: r, prices: prices.map(String), minPrice: String(minPrice), l1: Object.fromEntries(Object.entries(l1).map(([k, v]) => [k, String(v)])), balances: balances.map(([n, a, b]) => ({ n, a, b: String(b) })) }, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2))
    return
  }

  const when = new Date(Number(r.timestamp) * 1000).toISOString().replace('.000Z', ' UTC').replace('T', ' ')
  say(`chain ${chainId}, block ${l2Block} (ArbSys; ${r.blockNumber} is the parent chain's), block time ${when}; RPC ${RPC}`)
  const src = readFileSync(join(CONTRACTS, 'src', 'PoolRounds.sol'))
  say(`PoolRounds.sol sha256 ${createHash('sha256').update(src).digest('hex').slice(0, 16)}... (the code the probe deployed inside the call)`)
  say(`probe (eth_call, nothing persisted): PoolRounds deploy ${r.roundsDeployGas} gas, ReferralRegistry ${r.registryDeployGas}, wiring ${r.wireGas}; minCardinality ${r.minCardinality}`)
  say(`gas price (ArbGasInfo): L2 ${formatGwei(l2Price)} gwei, minimum ${formatGwei(minPrice)} gwei, L1 calldata ${formatGwei(prices[1])} gwei/byte`)
  say('')
  say('| Pool | WETH pool | canonical | depth, WETH (gate) | tick | ring (slot0) | history 300 s | price steps stored | first / last step, UTC | listPool as is | after the ring fix | after the ring and depth fixes | window depth fixStrike would see | observe 2 / 3 / 5 points, gas |')
  say('|---|---|---|---:|---:|---|---|---:|---|---|---|---|---|---|')
  r.pools.forEach((p: any, i: number) => {
    const name = POOLS[i][0]
    const ts = (t: bigint) => Number(t) ? new Date(Number(t) * 1000).toISOString().slice(0, 16).replace('T', ' ') : '-'
    const last = `${ts(p.firstSegmentTs)} / ${ts(p.lastSegmentTs)}`
    const res = (ok: boolean, err: Hex, gas?: bigint) => ok ? `passes${gas ? ` (${gas} gas)` : ''}` : `fails: ${errorName(rounds.abi, err)}`
    const asIs = res(p.listedAsIs, p.listErrorAsIs, p.listGasAsIs)
    const grow = p.listedAsIs ? 'not needed' : `${p.growOk ? `setCardinality ok (${p.growGas} gas), ring ${p.cardinalityAfterGrow}` : 'setCardinality reverted'}; ${res(p.listedAfterGrow, p.listErrorAfterGrow, p.listGasAfterGrow)}`
    const deep = p.listedAfterGrow ? 'not needed' : `${p.deepenOk ? `setLiquidity ok, depth ${Number(formatEther(p.depthAfterDeepen)).toFixed(0)}` : 'setLiquidity reverted'}; ${res(p.listedAfterDeepen, p.listErrorAfterDeepen)}`
    const wd = p.splDelta === 0n ? '0: observe() returns no secondsPerLiquidity, every activated round REFUND (thin)' : `${Number(formatEther(p.windowDepth)).toFixed(1)} WETH`
    const obs = [p.observe2Gas, p.observe3Gas, p.observe5Gas].map((g: bigint) => g === (2n ** 256n - 1n) ? 'reverted' : String(g)).join(' / ')
    say(`| ${name} \`${p.pool}\` | ${p.isWethPool ? (p.wethIsToken0 ? 'yes, token0' : 'yes, token1') : 'NO'} | ${p.canonical ? 'yes' : 'NO'} | ${Number(formatEther(p.depth)).toFixed(3)} (${formatEther(p.gateDepth)}) | ${p.tick} | ${p.cardinality}/${p.cardinalityNext} | ${p.canServeWindow ? 'yes' : 'NO'} | ${p.segments} | ${last} | ${asIs} | ${grow} | ${deep} | ${wd} | ${obs} |`)
  })
  say('')
  say('L1 part of each transaction (NodeInterface.gasEstimateL1Component, in L2 gas at the current price):')
  for (const [name] of txs) say(`  ${name}: ${l1[name]}`)
  say('')
  say('Balances (eth_getBalance):')
  for (const [name, a, b] of balances) say(`  ${name} ${a}: ${formatEther(b)} ETH`)
  say('')
  say(`${requests} RPC requests, all reads.`)
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exitCode = 1 })
