/**
 * Shared pieces of the PoolRounds deployment tooling (scripts/rhc/rounds-*.mts):
 * paths, the forge/anvil binaries, reading named variables from the repo-root .env
 * WITHOUT printing them, the real keeper code of backend/src/rounds loaded by import,
 * a file-backed keeper store, and a runner for contracts/script/DeployPoolRounds.s.sol.
 *
 * Nothing here sends a transaction by itself. The callers decide the network and
 * refuse anything that is not a local anvil or the testnet 46630.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Address, Hex } from 'viem'

const here = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolvePath(here, '../..')
export const CONTRACTS = join(ROOT, 'contracts')
export const BACKEND = join(ROOT, 'backend')
export const REPO_ENV = join(ROOT, '.env')
export const SOAK_WALLETS = join(here, '.soak-wallets.json')

export const TESTNET_ID = 46630
export const MAINNET_ID = 4663
export const TESTNET_RPC = 'https://rpc.testnet.chain.robinhood.com'

const WIN = process.platform === 'win32'
export const FOUNDRY_BIN = process.env.FOUNDRY_BIN ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.foundry', 'bin')
export const foundry = (name: 'forge' | 'anvil' | 'cast') => join(FOUNDRY_BIN, WIN ? `${name}.exe` : name)

// ── .env: named variables only, values never printed ────────────────────

/**
 * Parse a .env the way the other RHC scripts do (a ` #` starts a comment, surrounding
 * quotes are dropped) and return ONLY the names asked for. A missing file or name is
 * simply absent. Nothing is logged, and nothing is put into process.env here.
 */
export function readEnvNames(names: readonly string[], file = REPO_ENV): Record<string, string> {
  const out: Record<string, string> = {}
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return out }
  const want = new Set(names)
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m || !want.has(m[1])) continue
    const v = m[2].split(' #')[0].trim().replace(/^"|"$/g, '')
    if (v) out[m[1]] = v
  }
  return out
}

export function asKey(v: string | undefined, what: string): Hex {
  const k = (v ?? '').trim()
  const hex = k.startsWith('0x') ? k : `0x${k}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${what} is not a 32-byte hex key (value not shown)`)
  return hex as Hex
}

/** Keys of the throwaway soak wallets (scripts/rhc/.soak-wallets.json, ignored by git). Never printed. */
export function readSoakKeys(file = SOAK_WALLETS): Hex[] {
  if (!existsSync(file)) return []
  const keys = (JSON.parse(readFileSync(file, 'utf8')).keys ?? []) as string[]
  return keys.map((k, i) => asKey(k, `soak wallet #${i}`))
}

// ── forge artifacts ─────────────────────────────────────────────────────

export function artifact(rel: string): { abi: any; bytecode: Hex } {
  const j = JSON.parse(readFileSync(join(CONTRACTS, 'out', rel), 'utf8'))
  return { abi: j.abi, bytecode: j.bytecode.object as Hex }
}

// ── the backend's own viem and keeper code ─────────────────────────────

/**
 * The viem module instance the backend code runs on. scripts/ and backend/ resolve
 * viem to two different pnpm folders (the same version with different peers), and
 * the keeper's revertReason() tells contract errors apart with `instanceof`, which is
 * false across instances. So every client handed to the keeper is built from this.
 */
export async function backendViem(): Promise<typeof import('viem')> {
  const dir = realpathSync(join(BACKEND, 'node_modules', 'viem'))
  return import(pathToFileURL(join(dir, '_esm', 'index.js')).href)
}

export interface KeeperModules {
  viem: typeof import('viem')
  createRoundsKeeper: any
  createViemRoundsChain: any
  MemoryRoundsStore: any
  readRoundsConfig: any
  getKeeperWalletClient: any
  sendKeeperTx: any
  revertReason: (e: unknown) => string
  chainId: number
}

/**
 * Load backend/src/rounds (and the keeper wallet it shares with the other keeper loops)
 * for one RPC and one keeper key. The backend reads its chain and key from process.env
 * AT IMPORT TIME, so they are set here first, and CHAIN_ID is removed: the repo .env
 * carries a Base chain id, and CHAIN_ID=4663 would point the rhc profile at mainnet.
 * Loaded once per process.
 */
let loaded: KeeperModules | null = null
export async function loadKeeperCode(rpcUrl: string, keeperKey: Hex): Promise<KeeperModules> {
  if (loaded) throw new Error('keeper code already loaded in this process')
  process.env.CHAIN_PROFILE = 'rhc'
  delete process.env.CHAIN_ID
  process.env.RHC_RPC_URL = rpcUrl
  process.env.KEEPER_PRIVATE_KEY = keeperKey
  const src = (p: string) => pathToFileURL(join(BACKEND, 'src', p)).href
  const profile = await import(src('chainProfile.js'))
  if (profile.CHAIN_PROFILE.chain.id !== TESTNET_ID) throw new Error(`backend chain profile is ${profile.CHAIN_PROFILE.chain.id}, expected ${TESTNET_ID}`)
  if (profile.CHAIN_PROFILE.rpcUrl !== rpcUrl) throw new Error('backend chain profile did not take the RPC given')
  const wallet = await import(src('keeper/keeperWallet.js'))
  const keeper = await import(src('rounds/keeper.js'))
  const chain = await import(src('rounds/chain.js'))
  const store = await import(src('rounds/store.js'))
  const config = await import(src('rounds/config.js'))
  const viem = await backendViem()
  loaded = {
    viem,
    createRoundsKeeper: keeper.createRoundsKeeper,
    createViemRoundsChain: chain.createViemRoundsChain,
    MemoryRoundsStore: store.MemoryRoundsStore,
    readRoundsConfig: config.readRoundsConfig,
    getKeeperWalletClient: wallet.getKeeperWalletClient,
    sendKeeperTx: wallet.sendKeeperTx,
    revertReason: chain.revertReason,
    chainId: profile.CHAIN_PROFILE.chain.id,
  }
  // The instanceof trap above, checked rather than assumed: an error made by the
  // viem this file hands to the keeper must decode to its contract error name.
  const notDue = [{ type: 'error', name: 'NotDue', inputs: [{ name: 'roundId', type: 'uint256' }] }] as const
  const probe = new viem.ContractFunctionRevertedError({
    abi: notDue as any,
    data: viem.encodeErrorResult({ abi: notDue, errorName: 'NotDue', args: [1n] }),
    functionName: 'settle',
  })
  if (loaded.revertReason(probe) !== 'NotDue') throw new Error('keeper code and this script disagree on the viem instance: contract errors would not decode')
  return loaded
}

// ── a keeper store that survives a restart without Redis ────────────────

/**
 * RoundsStore (backend/src/rounds/store.ts) in a JSON file: the cursor, the open
 * rounds, the spend per round and the 48 h spend log. What Redis keeps for the
 * server's keeper, kept on disk for a keeper run from this machine, so that a
 * restart does not forget what a round has already cost. Written whole, through
 * a temporary file and a rename.
 */
export class FileRoundsStore {
  private s: { cursor: string | null; open: string[]; spent: Record<string, string>; log: Array<[number, string, string]>; snapshot: unknown }
  constructor(private file: string) {
    this.s = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8'))
      : { cursor: null, open: [], spent: {}, log: [], snapshot: null }
  }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.s, null, 1))
    renameSync(tmp, this.file)
  }
  async getCursor() { return this.s.cursor === null ? null : BigInt(this.s.cursor) }
  async setCursor(b: bigint) { this.s.cursor = b.toString(); this.save() }
  async openRounds() { return this.s.open.map((x) => BigInt(x)) }
  async addOpen(ids: bigint[]) { const set = new Set(this.s.open); for (const id of ids) set.add(id.toString()); this.s.open = [...set]; this.save() }
  async removeOpen(ids: bigint[]) { const drop = new Set(ids.map(String)); this.s.open = this.s.open.filter((x) => !drop.has(x)); this.save() }
  async getSpent(id: bigint) { return BigInt(this.s.spent[id.toString()] ?? '0') }
  async addSpent(id: bigint, delta: bigint) {
    const next = (BigInt(this.s.spent[id.toString()] ?? '0')) + delta
    this.s.spent[id.toString()] = next.toString()
    this.save()
    return next
  }
  async logSpend(atMs: number, wei: bigint, ref: string) {
    const keepFrom = atMs - 48 * 3600_000
    this.s.log = this.s.log.filter((e) => e[0] >= keepFrom)
    this.s.log.push([atMs, wei.toString(), ref])
    this.save()
  }
  async spentSince(sinceMs: number) { return this.s.log.filter((e) => e[0] >= sinceMs).reduce((a, e) => a + BigInt(e[1]), 0n) }
  async publish(snapshot: unknown) { this.s.snapshot = snapshot; this.save() }
}

// ── DeployPoolRounds.s.sol ──────────────────────────────────────────────

export interface DeployRun {
  code: number
  stdout: string
  stderr: string
  rounds: Address | null
  registry: Address | null
  /** Receipts of the broadcast, in order, when there was one. */
  txs: Array<{ what: string; hash: Hex; gasUsed: bigint; block: bigint }>
  broadcastFile: string | null
}

/** Only what forge needs to run: no key, address or RPC of the caller's shell leaks into the script. */
function baseEnv(): Record<string, string> {
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'COMSPEC', 'PATHEXT']
  const out: Record<string, string> = {}
  for (const k of keep) if (process.env[k]) out[k] = process.env[k] as string
  return out
}

/**
 * Run contracts/script/DeployPoolRounds.s.sol with exactly `vars` as its environment.
 * `broadcast` false is forge's own simulation (nothing is sent). `broadcastDir`
 * redirects forge's broadcast/ record (FOUNDRY_BROADCAST), so a local rehearsal does
 * not write next to the real testnet records in contracts/broadcast.
 */
export function runDeployScript(opts: {
  rpcUrl: string
  vars: Record<string, string>
  broadcast: boolean
  chainId: number
  broadcastDir?: string
  onLine?: (line: string) => void
}): Promise<DeployRun> {
  const args = ['script', 'script/DeployPoolRounds.s.sol', '--rpc-url', opts.rpcUrl]
  if (opts.broadcast) args.push('--broadcast', '--slow')
  const env = { ...baseEnv(), ...opts.vars, ...(opts.broadcastDir ? { FOUNDRY_BROADCAST: opts.broadcastDir } : {}) }
  const startedMs = Date.now()
  /**
   * forge also writes the RPC of a run ("sensitive values") under contracts/cache/<script>/<chain>/.
   * A rehearsal on a local anvil removes what it wrote there, and only that, so a local run with
   * chain id 46630 leaves nothing next to the testnet's own records. A testnet run keeps forge's files.
   */
  const tidyCache = () => {
    if (!opts.broadcastDir || !isLocalUrl(opts.rpcUrl)) return
    for (const dir of [join(CONTRACTS, 'cache', 'DeployPoolRounds.s.sol', String(opts.chainId)), join(CONTRACTS, 'cache', 'DeployPoolRounds.s.sol', String(opts.chainId), 'dry-run')]) {
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir)) {
        const path = join(dir, f)
        const st = statSync(path)
        if (st.isFile() && st.mtimeMs >= startedMs - 1000) rmSync(path)
      }
    }
    // and the folders, once empty (deepest first)
    const script = join(CONTRACTS, 'cache', 'DeployPoolRounds.s.sol')
    for (const dir of [join(script, String(opts.chainId), 'dry-run'), join(script, String(opts.chainId)), script]) {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true })
    }
  }
  return new Promise((done, fail) => {
    const p = spawn(foundry('forge'), args, { cwd: CONTRACTS, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => { stdout += d; for (const l of String(d).split(/\r?\n/)) if (l.trim()) opts.onLine?.(l) })
    p.stderr.on('data', (d) => { stderr += d })
    p.on('error', fail)
    p.on('close', (code) => {
      tidyCache()
      const grab = (k: string) => (stdout.match(new RegExp(`^\\s*${k}=(0x[0-9a-fA-F]{40})\\s*$`, 'm'))?.[1] ?? null) as Address | null
      const dir = opts.broadcastDir ?? join(CONTRACTS, 'broadcast')
      const file = join(dir, 'DeployPoolRounds.s.sol', String(opts.chainId), 'run-latest.json')
      const txs: DeployRun['txs'] = []
      let broadcastFile: string | null = null
      if (opts.broadcast && code === 0 && existsSync(file)) {
        broadcastFile = file
        const j = JSON.parse(readFileSync(file, 'utf8'))
        j.transactions.forEach((t: any, i: number) => {
          const r = j.receipts[i]
          txs.push({
            what: t.transactionType === 'CREATE' ? `deploy ${t.contractName}` : `${t.contractName ?? '?'}.${String(t.function ?? '').split('(')[0]}`,
            hash: (r?.transactionHash ?? t.hash) as Hex,
            gasUsed: BigInt(r?.gasUsed ?? 0),
            block: BigInt(r?.blockNumber ?? 0),
          })
        })
      }
      done({ code: code ?? 1, stdout, stderr, rounds: grab('POOL_ROUNDS'), registry: grab('POOL_ROUNDS_REFERRAL_REGISTRY'), txs, broadcastFile })
    })
  })
}

/** A Solidity numeric literal as the sources write them: `2500`, `69_692e9`, `0.02 ether`, `2 ether`, `300`. */
function solidityNumber(expr: string): bigint {
  const m = expr.trim().replace(/_/g, '').match(/^(\d+)(?:\.(\d+))?(?:e(\d+))?\s*(ether|gwei|wei|seconds|minutes|hours)?$/)
  if (!m) throw new Error(`cannot read the Solidity literal ${JSON.stringify(expr)}`)
  const [, int, frac = '', exp = '0', unit = 'wei'] = m
  const scale = BigInt(exp) + (unit === 'ether' ? 18n : unit === 'gwei' ? 9n : 0n) - BigInt(frac.length)
  const digits = BigInt(int + frac)
  if (scale < 0n) throw new Error(`fractional value in ${expr}`)
  const times = unit === 'minutes' ? 60n : unit === 'hours' ? 3600n : 1n
  return digits * 10n ** scale * times
}

/**
 * A default of contracts/script/DeployPoolRounds.s.sol, `vm.envOr("NAME", uint256(<literal>))`, read
 * from the source so that these tools follow the script instead of repeating its numbers.
 */
export function deployScriptDefault(name: string): bigint {
  const src = readFileSync(join(CONTRACTS, 'script', 'DeployPoolRounds.s.sol'), 'utf8')
  const m = src.match(new RegExp(`envOr\\("${name}",\\s*uint256\\(([^)]*)\\)\\)`))
  if (!m) throw new Error(`${name} has no uint256 default in DeployPoolRounds.s.sol`)
  return solidityNumber(m[1])
}

/** A `uint256 public constant NAME = <literal>;` of contracts/src/PoolRounds.sol. */
export function roundsConstant(name: string): bigint {
  const src = readFileSync(join(CONTRACTS, 'src', 'PoolRounds.sol'), 'utf8')
  const m = src.match(new RegExp(`constant\\s+${name}\\s*=\\s*([^;]+);`))
  if (!m) throw new Error(`constant ${name} not found in PoolRounds.sol`)
  return solidityNumber(m[1])
}

/**
 * The deployment the script would make with `env` (shell or .env overrides, else the script's own
 * defaults): the parameters the listing gate depends on, and the gate itself as listPool computes it,
 * gateDepth = max(MIN_POOL_WETH_DEPTH, depthPerBank x minBank) and minCardinality =
 * max(strikeWindow, 300 s exit cap) + CARDINALITY_SLACK.
 */
export function plannedGate(env: Record<string, string | undefined> = {}) {
  const pick = (k: string) => (env[k] ? BigInt(env[k] as string) : deployScriptDefault(k))
  const depthPerBank = pick('ROUNDS_DEPTH_PER_BANK')
  const minBank = pick('ROUNDS_MIN_BANK')
  const strikeWindow = pick('ROUNDS_STRIKE_WINDOW')
  const floor = roundsConstant('MIN_POOL_WETH_DEPTH')
  const gateDepth = depthPerBank * minBank > floor ? depthPerBank * minBank : floor
  return { depthPerBank, minBank, strikeWindow, gateDepth, minCardinality: ringNeeded(Number(strikeWindow)) }
}

/**
 * Default WETH depth, in whole WETH, for new stand-in pools: 20 times the gate, and at least 1 000,
 * so that a round's bank may reach depth / depthPerBank = 20 x minBank (0.4 WETH with the defaults).
 */
export function standinDepthEth(gateDepth: bigint): bigint {
  const twenty = (gateDepth * 20n + 10n ** 18n - 1n) / 10n ** 18n
  return twenty > 1000n ? twenty : 1000n
}

/**
 * The ring PoolRounds.listPool will require with a strike window of `strikeWindow` seconds:
 * max(strikeWindow, TWAP_WINDOW_CAP) + CARDINALITY_SLACK, both constants read from the sources so that
 * this follows the contract (the slack was 120 until the re-audit fixes, 600 after).
 */
export function ringNeeded(strikeWindow = 300): number {
  const slack = Number(roundsConstant('CARDINALITY_SLACK'))
  const oracle = readFileSync(join(CONTRACTS, 'src', 'PoolRoundOracle.sol'), 'utf8')
  const cap = oracle.match(/constant\s+TWAP_WINDOW_CAP\s*=\s*([^;]+);/)?.[1]
  if (!cap) throw new Error('TWAP_WINDOW_CAP not found in PoolRoundOracle.sol')
  return Math.max(strikeWindow, Number(solidityNumber(cap))) + slack
}

// ── stand-in pools that PoolRounds can price ────────────────────────────

/**
 * Deploy stand-in pools for PoolRounds: contracts/test/PoolRoundMockPool.sol, the mock the forge
 * tests use since the re-audit fixes. Unlike the demo pools' MockUniswapV3Pool it reports
 * secondsPerLiquidityCumulativeX128, from which fixStrike and settle take the WETH depth a window
 * carried; on a pool that reports zeros there every activated round ends REFUND (thin).
 *
 * Each pool: a MockToken (or the token given, e.g. an existing demo token, so the site shows its
 * name), PoolRoundMockPool at a 1% fee, registered in `factory` (MockUniswapV3Factory.register is
 * open to anyone; a NEW factory is deployed when none is given, so that the old keeper's poolWatcher,
 * which watches the demo factory, does not create PoolMarketFactory markets on these pools), two
 * hours of history at tick 0 in `history` steps, liquidity for `depthEth` WETH of depth at tick 0,
 * and a ring of `ring` slots. Every call is sent by `wallet`; the caller picks the network.
 */
export async function deployRoundStandins(o: {
  pub: any
  wallet: any
  weth: Address
  factory?: Address | null
  tokens: Array<{ symbol: string; token?: Address | null }>
  depthEth: bigint
  ring: number
  history?: number[]
  log?: (line: string) => void
}): Promise<{ factory: Address; pools: Array<{ symbol: string; token: Address; pool: Address; wethIsToken0: boolean }>; txs: Array<{ what: string; gas: bigint; hash: Hex }> }> {
  const say = o.log ?? (() => {})
  const txs: Array<{ what: string; gas: bigint; hash: Hex }> = []
  const mined = async (what: string, hash: Hex) => {
    const r = await o.pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
    if (r.status !== 'success') throw new Error(`${what} reverted, tx ${hash}`)
    txs.push({ what, gas: r.gasUsed, hash })
    return r
  }
  const deploy = async (rel: string, args: unknown[], what: string) => {
    const a = artifact(rel)
    const r = await mined(what, await o.wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args }))
    return r.contractAddress as Address
  }
  const call = async (address: Address, abi: any, functionName: string, args: unknown[], what: string) =>
    mined(what, await o.wallet.writeContract({ address, abi, functionName, args }))
  const factoryAbi = artifact('MockUniswapV3Factory.sol/MockUniswapV3Factory.json').abi
  const poolAbi = artifact('PoolRoundMockPool.sol/PoolRoundMockPool.json').abi

  const factory = o.factory ?? await deploy('MockUniswapV3Factory.sol/MockUniswapV3Factory.json', [], 'deploy MockUniswapV3Factory (rounds only)')
  say(`stand-in factory ${factory}${o.factory ? ' (given)' : ' (new, rounds only)'}`)
  const now = Number((await o.pub.getBlock({ blockTag: 'latest' })).timestamp)
  const pools: Array<{ symbol: string; token: Address; pool: Address; wethIsToken0: boolean }> = []
  for (const [i, t] of o.tokens.entries()) {
    const token = t.token ?? await deploy('MockToken.sol/MockToken.json', [t.symbol, t.symbol, 18], `deploy MockToken ${t.symbol}`)
    const wethIsToken0 = o.weth.toLowerCase() < token.toLowerCase()
    const [a0, a1] = wethIsToken0 ? [o.weth, token] : [token, o.weth]
    const pool = await deploy('PoolRoundMockPool.sol/PoolRoundMockPool.json', [a0, a1, 10_000], `deploy PoolRoundMockPool ${t.symbol}`)
    await call(factory, factoryAbi, 'register', [a0, a1, 10_000, pool], `register ${t.symbol}`)
    const steps = Math.max(1, o.history?.[i] ?? 1)
    for (let j = 0; j < steps; j++) {
      // The last step at tick 0; earlier ones alternate, so each is a real change of price.
      await call(pool, poolAbi, 'pushTick', [now - 7200 + j * 60, (steps - 1 - j) % 2 === 0 ? 0 : 10], `pushTick ${t.symbol}`)
    }
    // At tick 0 sqrt(P) = 1, so the WETH depth equals the liquidity whatever the orientation.
    await call(pool, poolAbi, 'setLiquidity', [o.depthEth * 10n ** 18n], `setLiquidity ${t.symbol}`)
    await call(pool, poolAbi, 'setCardinality', [o.ring, o.ring], `setCardinality ${t.symbol}`)
    pools.push({ symbol: t.symbol, token, pool, wethIsToken0 })
    say(`${t.symbol}: token ${token}, pool ${pool}, WETH is token${wethIsToken0 ? 0 : 1}, ${steps} stored price step(s), depth ${o.depthEth} WETH, ring ${o.ring}`)
  }
  return { factory, pools, txs }
}

// ── a local anvil that prices gas the way Robinhood Chain does ───────────

/**
 * A JSON-RPC front for a LOCAL anvil, on 127.0.0.1, that makes two answers match the
 * testnet: eth_maxPriorityFeePerGas is 0 (Arbitrum has no tip; anvil says 1 gwei, which
 * would make every keeper transaction look 100 times dearer than on the chain and fail
 * the round budget), and every block is mined at the chain's floor base fee of 0.01 gwei
 * (anvil lowers the base fee of near-empty blocks; the proxy pins the next block's base
 * fee before each send and each mine). Everything else passes through untouched.
 */
export async function startChainLikeProxy(anvilUrl: string, baseFeeWei = 10_000_000n): Promise<{ url: string; close: () => void }> {
  if (!isLocalUrl(anvilUrl)) throw new Error('the gas proxy only fronts a local anvil')
  const { createServer } = await import('node:http')
  const pinHex = `0x${baseFeeWei.toString(16)}`
  const post = async (body: unknown) => {
    const r = await fetch(anvilUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return r.json()
  }
  const PIN_BEFORE = new Set(['eth_sendRawTransaction', 'eth_sendTransaction', 'evm_mine', 'anvil_mine'])
  const one = async (req: any) => {
    if (PIN_BEFORE.has(req?.method)) await post({ jsonrpc: '2.0', id: 0, method: 'anvil_setNextBlockBaseFeePerGas', params: [pinHex] })
    if (req?.method === 'eth_maxPriorityFeePerGas') return { jsonrpc: '2.0', id: req.id, result: '0x0' }
    return post(req)
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw)
        const answer = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(answer))
      } catch (e) {
        res.writeHead(500)
        res.end(String(e))
      }
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
}

// ── small things ────────────────────────────────────────────────────────

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const fmtEth = (wei: bigint, digits = 6) => {
  const neg = wei < 0n
  const w = neg ? -wei : wei
  const s = `${w / 10n ** 18n}.${(w % 10n ** 18n).toString().padStart(18, '0').slice(0, digits)}`
  return neg ? `-${s}` : s
}
export const isLocalUrl = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(url)
