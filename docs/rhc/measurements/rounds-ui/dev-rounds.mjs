// Starts the frontend dev server against the local anvil deployment written by
// anvil-local.mjs deploy, with the rounds screen switched on. LOCAL ONLY:
// every address comes from the local state file, the RPC is 127.0.0.1, the API
// points at a closed local port (the rounds screen reads the chain directly),
// and the region check is off as for any local build.
//
//   node docs/rhc/measurements/rounds-ui/dev-rounds.mjs [--port 5174] [--state file]
//
// Variables set here win over frontend/.env.local (Vite never overrides a
// variable that already exists in the process environment).
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../../..')
const args = process.argv.slice(2)
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d)
const s = JSON.parse(readFileSync(resolve(opt('state', resolve(HERE, '.anvil-state.json'))), 'utf8'))
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(s.rpc)) throw new Error('state file does not point at a local node')
const port = opt('port', '5174')
const PLACEHOLDER = '0x000000000000000000000000000000000000dEaD'

const env = {
  ...process.env,
  VITE_NETWORK: 'rhc-testnet',
  VITE_RHC_RPC_URL: s.rpc,
  VITE_API_URL: 'http://127.0.0.1:9',
  VITE_DISABLE_GEOBLOCK: '1',
  VITE_ROUNDS_ENABLED: '1',
  VITE_POOL_ROUNDS_ADDRESS: s.rounds,
  VITE_ROUNDS_DEPLOY_BLOCK: s.deployBlock,
  VITE_ROUNDS_DURATIONS: '300,900',
  // Required by the rest of the app's env check; the rounds screen does not use them.
  VITE_USDC_ADDRESS: s.weth,
  VITE_MARKET_FACTORY: PLACEHOLDER,
  VITE_ORACLE_RESOLVER: PLACEHOLDER,
  VITE_FEE_DISTRIBUTOR: PLACEHOLDER,
  VITE_REFERRAL_REGISTRY: PLACEHOLDER,
  VITE_BADGE_NFT: PLACEHOLDER,
  VITE_LIQUIDITY_POOL: PLACEHOLDER,
  VITE_GENESIS_NFT: PLACEHOLDER,
}
const vite = resolve(ROOT, 'frontend/node_modules/vite/bin/vite.js')
const child = spawn(process.execPath, [vite, '--port', port, '--strictPort', '--host', '127.0.0.1'], {
  cwd: resolve(ROOT, 'frontend'),
  env,
  stdio: 'inherit',
})
child.on('exit', (code) => process.exit(code ?? 0))
