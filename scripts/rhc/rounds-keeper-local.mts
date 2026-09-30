/**
 * The PoolRounds keeper run from this machine, without Postgres and without Redis (variant A of
 * docs/rhc/ROUNDS-DEPLOY.md, step 6). It is the server's code, imported from backend/src/rounds:
 * discovery, planner, budget, the shared keeperWallet.sendKeeperTx; only the Redis store is
 * replaced by a JSON file next to this script, so a restart does not forget what a round has
 * already cost (scripts/rhc/.rounds-keeper-<address>.json, ignored by git like every *.json here).
 *
 *   scripts\node_modules\.bin\tsx scripts\rhc\rounds-keeper-local.mts            runs until Ctrl+C
 *   scripts\node_modules\.bin\tsx scripts\rhc\rounds-keeper-local.mts --once     one tick, then exits
 *
 * Variables, from the shell first and then from the repo-root .env (values never printed):
 *   ROUNDS_ADDRESS, ROUNDS_START_BLOCK   as printed by rounds-deploy.mts after the deployment
 *   the key named by --key-env (default PRIVATE_KEY, the deployer). KEEPER_PRIVATE_KEY is refused
 *   unless --allow-server-keeper-key: the server's keeper sends from it for the old markets, and two
 *   processes on one wallet collide on nonces (the 2026-07-06 incident keeperWallet.ts exists for).
 *   Any ROUNDS_* tunable of backend/src/rounds/config.ts (ROUNDS_INTERVAL_MS and the rest).
 * Options: --rpc URL (default the public testnet RPC; a 127.0.0.1 anvil is accepted), --env-file PATH.
 *
 * Refuses any chain but 46630. It only calls fixStrike, settle and withdrawFees, each after a dry run,
 * each inside the round's own costAllowance. It stops when this window closes: nothing runs it
 * after a reboot, and a round whose fixStrike is not sent by keeperDeadlines(roundId).fixStrikeBy (read
 * from the contract; strikeEnd + 599 s with the current defaults) on a busy real pool
 * ends as a REFUND (on the testnet stand-ins history never runs out, so it would not show there).
 */
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, defineChain, formatEther, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { asKey, FileRoundsStore, isLocalUrl, loadKeeperCode, MAINNET_ID, readEnvNames, REPO_ENV, sleep, TESTNET_ID, TESTNET_RPC } from './rounds-lib.mts'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
const ONCE = argv.includes('--once')
const RPC = opt('--rpc') ?? process.env.RHC_RPC_URL ?? TESTNET_RPC
const ENV_FILE = opt('--env-file') ?? REPO_ENV
const KEY_ENV = opt('--key-env') ?? 'PRIVATE_KEY'
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (m: string) => console.log(`[${stamp()}] ${m}`)

async function main() {
  if (!(RPC === TESTNET_RPC || isLocalUrl(RPC))) throw new Error(`RPC must be ${TESTNET_RPC} or a 127.0.0.1 anvil, got ${RPC}`)
  if (KEY_ENV === 'KEEPER_PRIVATE_KEY' && !argv.includes('--allow-server-keeper-key')) {
    throw new Error('KEEPER_PRIVATE_KEY is the server keeper\'s wallet; two processes on one wallet collide on nonces. Use --key-env with another variable')
  }
  const chain = defineChain({ id: TESTNET_ID, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
  const id = await createPublicClient({ chain, transport: http(RPC) }).getChainId()
  if (id === MAINNET_ID) throw new Error('this is MAINNET 4663: refusing')
  if (id !== TESTNET_ID) throw new Error(`chain ${id} is not the testnet ${TESTNET_ID}: refusing`)

  // Every ROUNDS_* the config knows, from the shell over the .env; the key by name only.
  const names = ['ROUNDS_ADDRESS', 'ROUNDS_START_BLOCK', 'ROUNDS_INTERVAL_MS', 'ROUNDS_LOG_CHUNK_BLOCKS', 'ROUNDS_LOG_OVERLAP_BLOCKS', 'ROUNDS_LOOKBACK_BLOCKS', 'ROUNDS_MAX_LOG_CHUNKS_PER_TICK', 'ROUNDS_CONFIRMATIONS', 'ROUNDS_GRACE_RESERVE_BPS', 'ROUNDS_L1_RESERVE_WEI', 'ROUNDS_FEES_WITHDRAW_MIN_ETH', 'ROUNDS_RECEIPT_TIMEOUT_MS', 'ROUNDS_MAX_TX_PER_TICK']
  const file = readEnvNames([...names, KEY_ENV], ENV_FILE)
  const env: Record<string, string> = { ROUNDS_ENABLED: 'true' }
  for (const k of names) { const v = (process.env[k] ?? '').trim() || file[k]; if (v) env[k] = v }
  const key = asKey((process.env[KEY_ENV] ?? '').trim() || file[KEY_ENV], KEY_ENV)
  const address = privateKeyToAccount(key).address

  const km = await loadKeeperCode(RPC, key)
  const cfg = km.readRoundsConfig(env, (m: string) => log(`config: ${m}`))
  if (!cfg.enabled) throw new Error(`not started: ${cfg.error}`)
  const wallet = km.getKeeperWalletClient()
  const publicClient = km.viem.createPublicClient({ chain: wallet.chain, transport: km.viem.http(RPC) })
  const stateFile = join(here, `.rounds-keeper-${cfg.config.deployment.address.toLowerCase()}.json`)
  const store = new FileRoundsStore(stateFile)
  const keeper = km.createRoundsKeeper({
    chain: km.createViemRoundsChain({ publicClient, wallet, address: cfg.config.deployment.address }),
    store,
    sendTx: km.sendKeeperTx,
    gasGuard: {
      check: async () => null,
      record: async (r: any, p: string) => log(`paid ${r.gasUsed} gas x ${r.effectiveGasPrice} wei (${p})`),
    },
    config: cfg.config,
    log: { info: (m: string) => log(m), warn: (m: string) => log(`warn: ${m}`), error: (m: string) => log(`ERROR: ${m}`) },
  })
  log(`PoolRounds keeper on ${cfg.config.deployment.address}, chain ${id}, wallet ${address} (${KEY_ENV}), ` +
    `${formatEther(await publicClient.getBalance({ address }))} ETH, start block ${cfg.config.deployment.startBlock ?? 'lookback'}, ` +
    `every ${cfg.config.intervalMs} ms, state ${stateFile}`)

  let lastBeat = 0
  for (;;) {
    const s = Date.now()
    try {
      const rep = await keeper.tick()
      const sent = (rep.actions ?? []).filter((a: any) => a.outcome.kind === 'sent').length
      if (sent || Date.now() - lastBeat > 10 * 60_000 || ONCE) {
        const sn = rep.snapshot ?? {}
        log(`tick ${Date.now() - s} ms: head ${sn.headBlock}, open ${sn.open}, collecting ${sn.collecting}, awaiting fixStrike ${sn.awaitingFixStrike}, settle ${sn.awaitingSettle}, 24 h ${sn.awaitingGraceSettle}, over budget ${sn.overBudget}, ${sent} tx; keeper ${sn.keeperWei ? formatEther(BigInt(sn.keeperWei)) : '?'} ETH`)
        lastBeat = Date.now()
      }
    } catch (e: any) {
      log(`tick failed: ${String(e?.shortMessage ?? e?.message ?? e).split('\n')[0]}`)
    }
    if (ONCE) return
    await sleep(Math.max(0, cfg.config.intervalMs - (Date.now() - s)))
  }
}

// exitCode, not process.exit: on Windows exiting under open sockets can abort Node with a libuv assertion.
main().then(() => { process.exitCode = 0 }).catch((e) => { log(`STOP: ${String(e?.message ?? e).split('\n')[0]}`); process.exitCode = 1 })
