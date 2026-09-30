/**
 * PoolRounds on the Robinhood Chain testnet (46630), step by step, from a plain Windows cmd window.
 * The cmd sibling of contracts/script/deploy-rhc.ps1: forge does not read the repo-root .env and
 * cmd cannot parse its inline `# ...` comments, so this reads the named variables itself and hands
 * them to forge. Run from C:\Server\memepred (docs/rhc/ROUNDS-DEPLOY.md walks through it):
 *
 *   scripts\node_modules\.bin\tsx scripts\rhc\rounds-deploy.mts plan                      reads only
 *   scripts\node_modules\.bin\tsx scripts\rhc\rounds-deploy.mts standins --yes-testnet    stand-in pools PoolRounds can price
 *   scripts\node_modules\.bin\tsx scripts\rhc\rounds-deploy.mts simulate                  forge's own dry run, sends nothing
 *   scripts\node_modules\.bin\tsx scripts\rhc\rounds-deploy.mts deploy --yes-testnet      forge script --broadcast --slow
 *   scripts\node_modules\.bin\tsx scripts\rhc\rounds-deploy.mts after                     what to paste where, from the last broadcast
 *   scripts\node_modules\.bin\tsx scripts\rhc\rounds-deploy.mts pause --yes-testnet       rollback: stop new bets on ROUNDS_ADDRESS
 *
 * Refuses any chain but 46630 (4663 is refused by name). Values are never printed; addresses are.
 * Variables, from the shell first and then from the repo-root .env:
 *   PRIVATE_KEY (deployer = owner), MULTISIG_ADDRESS (must differ from the deployer), TREASURY_ADDRESS,
 *   KEEPER_ADDRESS (becomes the pauser), RHC_WETH_ADDRESS, RHC_V3_FACTORY_ADDRESS, the ROUNDS_*
 *   overrides of DeployPoolRounds.s.sol, and two of this tool:
 *   ROUNDS_V3_FACTORY_ADDRESS  the stand-in factory of the rounds (printed by `standins`); when set it
 *                              is what PoolRounds is deployed against, instead of RHC_V3_FACTORY_ADDRESS
 *   ROUNDS_STANDIN_TOKENS      tokens for `standins` (default the demo tokens MOONCAT, PEPE, FROGGO, so
 *                              the site shows their names; `new` deploys fresh MockTokens)
 *   ROUNDS_STANDIN_DEPTH_ETH   WETH depth of each new stand-in pool, default max(1000, 20 x the gate); never below
 *                              the gate depthPerBank x minBank (read from the script and the contract sources)
 * Options: --rpc URL (default the public testnet RPC; a 127.0.0.1 anvil is accepted for rehearsal, and
 *   then forge's records go to a temporary folder instead of contracts\broadcast), --env-file PATH.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPublicClient, createWalletClient, defineChain, formatEther, formatGwei, http, parseAbi,
  type Address, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  artifact, asKey, CONTRACTS, deployRoundStandins, ROOT, isLocalUrl, MAINNET_ID, plannedGate, readEnvNames, REPO_ENV, standinDepthEth,
  runDeployScript, TESTNET_ID, TESTNET_RPC,
} from './rounds-lib.mts'

const argv = process.argv.slice(2)
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--rpc' && argv[i - 1] !== '--env-file')
const cmd = positional[0] ?? 'plan'
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
const YES = argv.includes('--yes-testnet')
const RPC = opt('--rpc') ?? process.env.RHC_RPC_URL ?? TESTNET_RPC
const ENV_FILE = opt('--env-file') ?? REPO_ENV
const EXPLORER = 'https://explorer.testnet.chain.robinhood.com'
/** A rehearsal on a local anvil keeps forge's records out of contracts/broadcast, where the testnet's go. */
const BROADCAST_DIR = isLocalUrl(RPC) ? join(tmpdir(), 'rounds-deploy-rehearsal') : join(CONTRACTS, 'broadcast')
/** The demo tokens of docs/rhc/DEPLOYMENTS.md, reused so that the new pools carry their names. */
const DEMO_TOKENS: Address[] = [
  '0xDf1F40c97e6F191f1cEbd5Bec7678136a24522Cc', // MOONCAT
  '0xC12B7F3F9667c69075a89d3151153CE8E1EE6B4B', // PEPE
  '0xa1cF709d63f5C1f3e9E81Fd7abFA56ef3F8c0B94', // FROGGO
]

const REQUIRED = ['PRIVATE_KEY', 'MULTISIG_ADDRESS', 'TREASURY_ADDRESS', 'KEEPER_ADDRESS', 'RHC_WETH_ADDRESS', 'RHC_V3_FACTORY_ADDRESS'] as const
const SCRIPT_OPTIONAL = ['ROUNDS_POOLS', 'ROUNDS_REFERRAL_REGISTRY', 'ROUNDS_MAX_SIDE_RATIO', 'ROUNDS_STRIKE_PAUSE', 'ROUNDS_STRIKE_WINDOW', 'ROUNDS_DEPTH_PER_BANK', 'ROUNDS_MIN_STAKE', 'ROUNDS_MAX_STAKE', 'ROUNDS_COST_ALLOWANCE', 'ROUNDS_MIN_BANK', 'ROUNDS_DURATIONS', 'RHC_HANDOVER'] as const
const TOOL_OPTIONAL = ['ROUNDS_V3_FACTORY_ADDRESS', 'ROUNDS_STANDIN_TOKENS', 'ROUNDS_STANDIN_DEPTH_ETH', 'ROUNDS_ADDRESS'] as const

const POOL_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function observe(uint32[]) view returns (int56[],uint160[])',
])
const FACTORY_ABI = parseAbi(['function getPool(address,address,uint24) view returns (address)'])
const TOKEN_ABI = parseAbi(['function symbol() view returns (string)'])

function die(msg: string): never {
  throw new Error(msg)
}

async function main() {
  if (!['plan', 'standins', 'simulate', 'deploy', 'after', 'pause'].includes(cmd)) die(`unknown step "${cmd}": plan, standins, simulate, deploy, after or pause`)
  if (!(RPC === TESTNET_RPC || isLocalUrl(RPC))) die(`RPC must be ${TESTNET_RPC} or a 127.0.0.1 anvil, got ${RPC}`)
  const chain = defineChain({ id: TESTNET_ID, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
  const pub = createPublicClient({ chain, transport: http(RPC) })
  const id = await pub.getChainId()
  if (id === MAINNET_ID) die('this is Robinhood Chain MAINNET (4663). This tool deploys to the testnet only.')
  if (id !== TESTNET_ID) die(`chain ${id} is not the testnet ${TESTNET_ID}`)

  if (cmd === 'after') return after(pub)

  // ── variables: shell first, then the .env file; values stay unprinted ──
  const names = [...REQUIRED, ...SCRIPT_OPTIONAL, ...TOOL_OPTIONAL]
  const fileVars = readEnvNames(names, ENV_FILE)
  const v: Record<string, string> = {}
  for (const k of names) {
    const val = (process.env[k] ?? '').trim() || fileVars[k]
    if (val) v[k] = val
  }
  const missing = REQUIRED.filter((k) => !v[k])
  if (missing.length) die(`not set (in the shell or in ${ENV_FILE}): ${missing.join(', ')}`)
  const key = asKey(v.PRIVATE_KEY, 'PRIVATE_KEY')
  const deployer = privateKeyToAccount(key).address
  if (v.MULTISIG_ADDRESS.toLowerCase() === deployer.toLowerCase()) die('MULTISIG_ADDRESS equals the deployer; DeployPoolRounds.s.sol refuses that')
  if ((v.RHC_HANDOVER ?? '').trim() === 'true') console.log('note: RHC_HANDOVER=true: ownership will be offered to MULTISIG_ADDRESS (it must call acceptOwnership)')
  if (v.ROUNDS_MAX_SIDE_RATIO && v.ROUNDS_MAX_SIDE_RATIO !== '1') die('ROUNDS_MAX_SIDE_RATIO must be 1 (the script refuses anything else, re-audit V3-6)')

  const weth = v.RHC_WETH_ADDRESS as Address
  const factory = (v.ROUNDS_V3_FACTORY_ADDRESS ?? v.RHC_V3_FACTORY_ADDRESS) as Address
  const pools = (v.ROUNDS_POOLS ?? '').split(',').map((x) => x.trim()).filter(Boolean) as Address[]
  // The gate listPool will apply, from the overrides given or else the script's own defaults and the
  // contract's constants, read from the sources (rounds-lib.mts plannedGate): nothing repeated here.
  const planned = plannedGate(v)
  const { depthPerBank, minBank, gateDepth } = planned
  const ring = planned.minCardinality

  console.log(`chain ${id}, RPC ${RPC}`)
  console.log(`deployer (owner) ${deployer}: ${formatEther(await pub.getBalance({ address: deployer }))} ETH`)
  console.log(`multisig ${v.MULTISIG_ADDRESS}, treasury ${v.TREASURY_ADDRESS}, keeper/pauser ${v.KEEPER_ADDRESS}`)
  console.log(`WETH ${weth}; v3 factory PoolRounds will trust: ${factory}${v.ROUNDS_V3_FACTORY_ADDRESS ? ' (ROUNDS_V3_FACTORY_ADDRESS, the rounds stand-ins)' : ' (RHC_V3_FACTORY_ADDRESS, the demo stand-ins)'}`)
  for (const [k, a] of [['RHC_WETH_ADDRESS', weth], ['the v3 factory', factory]] as const) {
    if (!(await pub.getCode({ address: a }))) die(`${k} ${a} has no code on this chain`)
  }
  const overrides = SCRIPT_OPTIONAL.filter((k) => k !== 'ROUNDS_POOLS' && v[k]).map((k) => `${k}=${v[k]}`)
  console.log(`parameters: ${overrides.length ? overrides.join(', ') : 'the script defaults'}; depthPerBank ${depthPerBank}, minBank ${formatEther(minBank)}; listing gate: depth >= ${formatEther(gateDepth)} WETH, ring >= ${ring}`)
  const gasPrice = await pub.getGasPrice()
  console.log(`gas price ${formatGwei(gasPrice)} gwei`)

  if (cmd === 'pause') {
    // Rollback: stops bet() only; fixStrike, settle, claim and withdrawals keep working. Only the owner unpauses.
    const rounds = v.ROUNDS_ADDRESS as Address | undefined
    if (!rounds) die('ROUNDS_ADDRESS is not set')
    const PAUSE_ABI = parseAbi(['function pause()', 'function paused() view returns (bool)'])
    if (await pub.readContract({ address: rounds, abi: PAUSE_ABI, functionName: 'paused' })) { console.log(`\n${rounds} is already paused`); return }
    if (!YES) die('pause sends a transaction: add --yes-testnet')
    await pub.simulateContract({ account: deployer, address: rounds, abi: PAUSE_ABI, functionName: 'pause' })
    const wallet = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(RPC) })
    const hash = await wallet.writeContract({ address: rounds, abi: PAUSE_ABI, functionName: 'pause' })
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
    console.log(`\npause(): ${r.status}, gas ${r.gasUsed}, tx ${hash}; paused now ${await pub.readContract({ address: rounds, abi: PAUSE_ABI, functionName: 'paused' })}`)
    return
  }

  if (cmd === 'standins') {
    if (!YES) die('standins sends transactions: add --yes-testnet')
    const tokensVar = (v.ROUNDS_STANDIN_TOKENS ?? '').trim()
    const tokenAddrs = tokensVar.toLowerCase() === 'new' ? [] : (tokensVar ? tokensVar.split(',').map((x) => x.trim() as Address) : DEMO_TOKENS)
    const tokens = tokensVar.toLowerCase() === 'new'
      ? [{ symbol: 'MOONCAT' }, { symbol: 'PEPE' }, { symbol: 'FROGGO' }]
      : await Promise.all(tokenAddrs.map(async (t) => ({ token: t, symbol: await pub.readContract({ address: t, abi: TOKEN_ABI, functionName: 'symbol' }) })))
    const depthEth = v.ROUNDS_STANDIN_DEPTH_ETH ? BigInt(v.ROUNDS_STANDIN_DEPTH_ETH) : standinDepthEth(gateDepth)
    if (depthEth * 10n ** 18n < gateDepth) die(`ROUNDS_STANDIN_DEPTH_ETH ${depthEth} is below the gate ${formatEther(gateDepth)} WETH: listPool would refuse these pools`)
    console.log(`depth ${depthEth} WETH: a round's bank may reach ${formatEther((depthEth * 10n ** 18n) / depthPerBank)} WETH (depth / depthPerBank)`)
    const wallet = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(RPC) })
    console.log(`\nnew stand-ins: ${tokens.map((t) => t.symbol).join(', ')}, ${depthEth} WETH of depth each, ring ${ring}, in ${v.ROUNDS_V3_FACTORY_ADDRESS ? `the factory ${v.ROUNDS_V3_FACTORY_ADDRESS}` : 'a NEW factory of the rounds'}`)
    const st = await deployRoundStandins({
      pub, wallet, weth, factory: (v.ROUNDS_V3_FACTORY_ADDRESS as Address | undefined) ?? null, tokens, depthEth, ring,
      log: (l) => console.log(`  ${l}`),
    })
    const gas = st.txs.reduce((a, t) => a + t.gas, 0n)
    console.log(`  ${st.txs.length} transactions, ${gas} gas`)
    console.log('\n--- for this cmd window (or add the same lines, without "set ", to the repo-root .env) ---')
    console.log(`set ROUNDS_V3_FACTORY_ADDRESS=${st.factory}`)
    console.log(`set ROUNDS_POOLS=${st.pools.map((p) => p.pool).join(',')}`)
    return
  }

  // ── the listing gate, read pool by pool, before forge is asked to list anything ──
  if (!pools.length) console.log('\nROUNDS_POOLS is empty: PoolRounds would list no pool. Run `standins` first, or list later with listPool.')
  else console.log(`\npools to list (${pools.length}):`)
  const failing: string[] = []
  for (const p of pools) {
    const [t0, t1, fee, liq, s0] = await Promise.all([
      pub.readContract({ address: p, abi: POOL_ABI, functionName: 'token0' }),
      pub.readContract({ address: p, abi: POOL_ABI, functionName: 'token1' }),
      pub.readContract({ address: p, abi: POOL_ABI, functionName: 'fee' }),
      pub.readContract({ address: p, abi: POOL_ABI, functionName: 'liquidity' }),
      pub.readContract({ address: p, abi: POOL_ABI, functionName: 'slot0' }),
    ])
    const wethIs0 = t0.toLowerCase() === weth.toLowerCase()
    const isWeth = wethIs0 || t1.toLowerCase() === weth.toLowerCase()
    const canonical = (await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'getPool', args: [t0, t1, fee] })).toLowerCase() === p.toLowerCase()
    const sqrtP = s0[0]
    const depth = sqrtP === 0n ? 0n : wethIs0 ? (liq * (1n << 96n)) / sqrtP : (liq * sqrtP) / (1n << 96n)
    let history = true
    let spl = false
    try { await pub.readContract({ address: p, abi: POOL_ABI, functionName: 'observe', args: [[300, 0]] }) } catch { history = false }
    try {
      const [, s] = await pub.readContract({ address: p, abi: POOL_ABI, functionName: 'observe', args: [[305, 5]] })
      spl = s[1] !== s[0]
    } catch { /* history already reported */ }
    const ok = isWeth && canonical && depth >= gateDepth && s0[3] >= ring && history && spl
    if (!ok) failing.push(p)
    console.log(`  ${p}: WETH pool ${isWeth}, canonical in ${factory.slice(0, 10)} ${canonical}, depth ${Number(formatEther(depth)).toFixed(2)} WETH (gate ${formatEther(gateDepth)}), ring ${s0[3]} (gate ${ring}), 300 s of history ${history}, reports secondsPerLiquidity ${spl} -> ${ok ? 'OK' : 'NOT USABLE'}`)
  }
  if (failing.length) console.log('  NOT USABLE: listPool refuses it, or (no secondsPerLiquidity) every activated round on it ends REFUND. Make pools with `standins`.')

  if (cmd === 'plan') {
    console.log('\nnext:')
    if (!pools.length || failing.length) console.log(`  standins --yes-testnet   three stand-in pools PoolRounds can price (about 6.5 million gas with L1: ${formatEther(6_500_000n * gasPrice)} ETH today), then set the two lines it prints`)
    console.log(`  simulate, then deploy --yes-testnet   (about 7.5 million gas with L1: ${formatEther(7_500_000n * gasPrice)} ETH today)`)
    return
  }
  if (failing.length) die(`${failing.length} pool(s) in ROUNDS_POOLS are not usable (see above)`)

  // forge records the git commit of HEAD in the broadcast, and the source is verified from that commit
  // (DEPLOYMENTS.md). Uncommitted contract code would be deployed from a commit that does not hold it.
  if (!isLocalUrl(RPC)) {
    let dirty = ''
    try { dirty = execFileSync('git', ['status', '--porcelain', '--', 'contracts/src', 'contracts/script/DeployPoolRounds.s.sol'], { cwd: ROOT, encoding: 'utf8' }).trim() } catch { dirty = '(git status failed)' }
    if (dirty) {
      const msg = `contracts/src or the deploy script have changes that are not committed:\n${dirty}\nthe broadcast would name commit HEAD, which does not hold this code, and verification from that commit would fail`
      if (cmd === 'deploy' && !argv.includes('--allow-uncommitted')) die(`${msg}. Commit first (or add --allow-uncommitted and note the tree state in DEPLOYMENTS.md)`)
      console.log(`\nWARNING: ${msg}`)
    }
  }

  const vars: Record<string, string> = {}
  for (const k of [...REQUIRED, ...SCRIPT_OPTIONAL]) if (v[k]) vars[k] = v[k]
  vars.RHC_V3_FACTORY_ADDRESS = factory

  if (cmd === 'simulate') {
    console.log('\nforge script (simulation only, nothing is sent)...')
    const r = await runDeployScript({ rpcUrl: RPC, vars, broadcast: false, chainId: TESTNET_ID, broadcastDir: BROADCAST_DIR })
    console.log(r.stdout.split('\n').filter((l) => /chainId|PoolRounds|Registry|minCardinality|listed pool|HANDOVER|Handover|POOL_ROUNDS|Error|revert|Estimated|gas/i.test(l)).join('\n'))
    if (r.code !== 0) die(`forge exited ${r.code}: ${r.stderr.split('\n').slice(-5).join(' ')}`)
    console.log('\nsimulation ok. To send it: deploy --yes-testnet')
    return
  }

  if (!YES) die('deploy sends transactions: add --yes-testnet')
  console.log('\nforge script --broadcast --slow: BROADCASTING to the testnet 46630...')
  const r = await runDeployScript({ rpcUrl: RPC, vars, broadcast: true, chainId: TESTNET_ID, broadcastDir: BROADCAST_DIR, onLine: (l) => { if (/POOL_ROUNDS|listed pool|Handover|HANDOVER|Error/.test(l)) console.log(`  ${l.trim()}`) } })
  if (r.code !== 0) {
    console.log(r.stdout.split('\n').slice(-30).join('\n'))
    die(`forge exited ${r.code}. Anything already sent is recorded under ${BROADCAST_DIR}\\DeployPoolRounds.s.sol\\46630; look there before running again`)
  }
  await after(pub)
}

/** Everything to paste somewhere, from <broadcast>/DeployPoolRounds.s.sol/46630/run-latest.json. */
async function after(pub: any) {
  const file = join(BROADCAST_DIR, 'DeployPoolRounds.s.sol', String(TESTNET_ID), 'run-latest.json')
  if (!existsSync(file)) die(`no broadcast record at ${file}`)
  const j = JSON.parse(readFileSync(file, 'utf8'))
  const txs = j.transactions.map((t: any, i: number) => ({ t, r: j.receipts[i] }))
  const created = (name: string) => txs.find((x: any) => x.t.transactionType === 'CREATE' && x.t.contractName === name)
  const rounds = created('PoolRounds')
  const reg = created('ReferralRegistry')
  if (!rounds) die('the broadcast has no PoolRounds creation')
  const roundsAddr = rounds.t.contractAddress as Address
  const block = BigInt(txs[0].r.blockNumber)
  let wei = 0n
  let gas = 0n
  for (const { r } of txs) { gas += BigInt(r.gasUsed); wei += BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice ?? 0) }
  const art = artifact('PoolRounds.sol/PoolRounds.json')
  const input = (rounds.t.transaction.input ?? rounds.t.transaction.data) as Hex
  const ctorArgs = input.toLowerCase().startsWith(art.bytecode.toLowerCase()) ? `0x${input.slice(art.bytecode.length)}` : null
  const onChain = await pub.getCode({ address: roundsAddr })
  const commit = j.commit ?? '(not recorded)'
  const ts = Number(j.timestamp ?? Math.floor(Date.now() / 1000))
  const d = new Date(ts > 1e12 ? ts : ts * 1000).toISOString().slice(0, 10)
  const listed = txs.filter((x: any) => String(x.t.function ?? '').startsWith('listPool')).map((x: any) => x.t.arguments?.[0]).filter(Boolean)

  console.log(`\nPoolRounds ${roundsAddr} (code on chain: ${onChain && onChain !== '0x' ? 'yes' : 'NO'})`)
  if (reg) console.log(`ReferralRegistry ${reg.t.contractAddress}`)
  console.log(`first block ${block}, ${txs.length} transactions, ${gas} gas, ${formatEther(wei)} ETH, commit ${commit}`)
  for (const { t, r } of txs) console.log(`  ${t.transactionType === 'CREATE' ? `deploy ${t.contractName}` : `${t.contractName}.${String(t.function ?? '').split('(')[0]}`}: gas ${BigInt(r.gasUsed)}, tx ${r.transactionHash}`)

  console.log('\n--- keeper (ROUNDS-DEPLOY.md, step 6) ---')
  console.log(`ROUNDS_ENABLED=true\nROUNDS_ADDRESS=${roundsAddr}\nROUNDS_START_BLOCK=${block}`)
  console.log('\n--- site build, frontend\\.env.rhc-testnet (step 8) ---')
  console.log(`VITE_ROUNDS_ENABLED=1\nVITE_POOL_ROUNDS_ADDRESS=${roundsAddr}\nVITE_ROUNDS_DEPLOY_BLOCK=${block}\nVITE_ROUNDS_DURATIONS=300`)
  console.log('\n--- source verification, cmd (step 5) ---')
  console.log('cd /d C:\\Server\\memepred\\contracts')
  console.log('set BASESCAN_API_KEY=unused')
  const vc = (addr: string, path: string, extra = '') => `%USERPROFILE%\\.foundry\\bin\\forge.exe verify-contract ${addr} ${path} --chain-id 46630 --verifier blockscout --verifier-url ${EXPLORER}/api/${extra} --watch`
  console.log(vc(roundsAddr, 'src/PoolRounds.sol:PoolRounds', ctorArgs ? ` --constructor-args ${ctorArgs}` : ' --guess-constructor-args'))
  if (reg) console.log(vc(reg.t.contractAddress, 'src/ReferralRegistry.sol:ReferralRegistry'))
  console.log('\n--- DEPLOYMENTS.md, a new section to paste above the current one (step 9) ---')
  console.log(`## Robinhood Chain testnet, PoolRounds (раунды), деплой ${d}

Развёрнуто \`contracts/script/DeployPoolRounds.s.sol\` через \`scripts/rhc/rounds-deploy.mts\` из коммита \`${commit}\`
(записан в \`contracts/broadcast/DeployPoolRounds.s.sol/46630/run-latest.json\`), блок ${block}, ${txs.length} транзакций,
${gas} газа, ${formatEther(wei)} ETH. Контракты демо от 29.09 не тронуты.

| Контракт | Адрес |
|---|---|
| \`PoolRounds\` | \`${roundsAddr}\` |
| \`ReferralRegistry\` (новый, фабрика и допуск - \`PoolRounds\`) | \`${reg?.t.contractAddress ?? '-'}\` |

Владелец - деплойер, права мультисигу не переданы (\`RHC_HANDOVER\` не выставлен); \`pauser\` - кипер. Залистованы
стенд-ин пулы раундов (\`PoolRoundMockPool\`, своя стенд-ин фабрика, см. \`ROUNDS-DEPLOY.md\`): ${listed.length ? listed.map((a: string) => `\`${a}\``).join(', ') : '<заполнить>'}.
Верификация исходников: <заполнить: is_verified по API обозревателя>. Кипер раундов: <заполнить: где запущен, с какого времени>.`)
}

// No process.exit: on Windows it can race undici's sockets and abort Node with a libuv assertion.
main().catch((e) => {
  console.error(`\nSTOP: ${String(e?.shortMessage ?? e?.message ?? e).split('\n')[0]}`)
  process.exitCode = 1
})
