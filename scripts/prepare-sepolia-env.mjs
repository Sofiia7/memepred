#!/usr/bin/env node
/**
 * prepare-sepolia-env — Sprint 5 deploy prep
 *
 * Patches .env in place to make it Sepolia-ready:
 *   1. Switches USDC + RPC to Sepolia values.
 *   2. Generates fresh testnet wallets for any role that's still a
 *      placeholder: KEEPER, BADGE_MINTER, MULTISIG_STANDIN.
 *      The multisig "stand-in" is a single-key test EOA used in place of a
 *      real Safe — fine for the 48h Sepolia soak, NEVER for mainnet.
 *   3. Uses the deployer address for TREASURY / LP_FEE_SINK / NFT_REWARDS
 *      when empty (single-test-wallet pattern on testnet).
 *   4. Backs up the original to .env.before-sepolia for rollback.
 *
 * Generated privkeys are written to:
 *   - .env (via the matching key/address pair)
 *   - .testwallets/<role>.json (full keypair, for paste-back)
 *
 * SAFETY:
 *   - Idempotent: re-running does NOT regenerate keys already present.
 *   - Aborts if MULTISIG_ADDRESS is a real (non-placeholder) address —
 *     assumes the user manually pasted a real Safe.
 *   - Mainnet-looking USDC + RPC are flipped only when --confirm-sepolia
 *     is passed (one-shot acknowledgement).
 *
 * Usage:
 *   node scripts/prepare-sepolia-env.mjs --confirm-sepolia
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const ENV_PATH  = join(REPO_ROOT, '.env')
const BACKUP    = join(REPO_ROOT, '.env.before-sepolia')
const WALLET_DIR = join(REPO_ROOT, '.testwallets')

const CONFIRM = process.argv.includes('--confirm-sepolia')

// Sepolia chain references
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const SEPOLIA_RPC  = 'https://sepolia.base.org'
const SEPOLIA_PYTH = '0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a' // same as mainnet

if (!existsSync(ENV_PATH)) {
  console.error('.env not found at', ENV_PATH)
  process.exit(1)
}
if (!CONFIRM) {
  console.error('Pass --confirm-sepolia to acknowledge this will rewrite .env for Sepolia.')
  process.exit(2)
}

const raw = readFileSync(ENV_PATH, 'utf8')
writeFileSync(BACKUP, raw)
console.log(`backed up .env → ${BACKUP}`)

if (!existsSync(WALLET_DIR)) mkdirSync(WALLET_DIR, { recursive: true })

const lines = raw.split('\n')

/** Read current value of an env key (strips inline comment). */
function getEnv(key) {
  for (const l of lines) {
    const m = new RegExp(`^${key}=(.*)$`).exec(l)
    if (m) {
      const v = m[1].replace(/\s+#.*$/, '').trim()
      return v
    }
  }
  return ''
}

/** Replace (or append) an env key with the given value. */
function setEnv(key, value, comment = '') {
  const re  = new RegExp(`^${key}=.*$`)
  const tail = comment ? `  # ${comment}` : ''
  const newLine = `${key}=${value}${tail}`
  let replaced = false
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      lines[i] = newLine
      replaced = true
      break
    }
  }
  if (!replaced) lines.push(newLine)
}

function isPlaceholder(v) {
  return v === '' || v === '0x...' || v === '...' || v === '0x'
}

function isValidAddress(v) {
  return /^0x[a-fA-F0-9]{40}$/.test(v)
}

function isValidPrivKey(v) {
  return /^0x[a-fA-F0-9]{64}$/.test(v)
}

// ── 1. Deployer ───────────────────────────────────────────────
const deployerKey = getEnv('PRIVATE_KEY')
if (!isValidPrivKey(deployerKey)) {
  console.error('PRIVATE_KEY is not a valid 32-byte privkey. Fix .env first.')
  process.exit(3)
}
const deployer = privateKeyToAccount(deployerKey)
console.log(`deployer:           ${deployer.address}`)

// ── 2. Sepolia chain switch ───────────────────────────────────
const currentUsdc = getEnv('USDC_ADDRESS')
if (currentUsdc.toLowerCase() === SEPOLIA_USDC.toLowerCase()) {
  console.log('USDC already on Sepolia')
} else {
  console.log(`USDC: ${currentUsdc} → ${SEPOLIA_USDC} (Sepolia)`)
  setEnv('USDC_ADDRESS', SEPOLIA_USDC, 'Base Sepolia')
}

const currentRpc = getEnv('BASE_RPC_URL')
if (currentRpc.includes('sepolia')) {
  console.log('BASE_RPC_URL already on Sepolia')
} else {
  console.log(`BASE_RPC_URL: ${currentRpc} → ${SEPOLIA_RPC}`)
  setEnv('BASE_RPC_URL', SEPOLIA_RPC)
}

setEnv('PYTH_ADDRESS', SEPOLIA_PYTH, 'Pyth on Base (same address on Sepolia)')

// ── 3. Multisig stand-in for testnet ──────────────────────────
const multisig = getEnv('MULTISIG_ADDRESS')
let multisigStandinAddr = null
if (isValidAddress(multisig) && multisig.toLowerCase() !== deployer.address.toLowerCase()) {
  console.log(`MULTISIG_ADDRESS: present (${multisig.slice(0, 8)}…) — leaving alone`)
} else {
  const walletFile = join(WALLET_DIR, 'multisig-standin.json')
  let pk
  if (existsSync(walletFile)) {
    const w = JSON.parse(readFileSync(walletFile, 'utf8'))
    pk = w.privateKey
    multisigStandinAddr = w.address
    console.log(`MULTISIG stand-in: reused ${multisigStandinAddr}`)
  } else {
    pk = generatePrivateKey()
    const acct = privateKeyToAccount(pk)
    multisigStandinAddr = acct.address
    writeFileSync(walletFile, JSON.stringify({ privateKey: pk, address: acct.address }, null, 2))
    console.log(`MULTISIG stand-in: GENERATED ${acct.address}  (key in ${walletFile})`)
  }
  setEnv('MULTISIG_ADDRESS', multisigStandinAddr, 'TESTNET stand-in — replace with Safe before mainnet')
}

// ── 4. Keeper hot wallet ──────────────────────────────────────
const keeperAddr = getEnv('KEEPER_ADDRESS')
const keeperKey  = getEnv('KEEPER_PRIVATE_KEY')
let needNewKeeper = !isValidAddress(keeperAddr) || !isValidPrivKey(keeperKey)
if (needNewKeeper) {
  const walletFile = join(WALLET_DIR, 'keeper.json')
  let pk, addr
  if (existsSync(walletFile)) {
    const w = JSON.parse(readFileSync(walletFile, 'utf8'))
    pk = w.privateKey
    addr = w.address
    console.log(`KEEPER hot wallet: reused ${addr}`)
  } else {
    pk = generatePrivateKey()
    const acct = privateKeyToAccount(pk)
    pk = pk; addr = acct.address
    writeFileSync(walletFile, JSON.stringify({ privateKey: pk, address: addr }, null, 2))
    console.log(`KEEPER hot wallet: GENERATED ${addr}  (key in ${walletFile})`)
  }
  setEnv('KEEPER_ADDRESS',     addr, 'Hot wallet — keeper.json')
  setEnv('KEEPER_PRIVATE_KEY', pk,   'Hot wallet — keeper.json')
} else {
  console.log(`KEEPER hot wallet: present ${keeperAddr}`)
}

// ── 5. Badge minter ───────────────────────────────────────────
const badgeAddr = getEnv('BADGE_MINTER_ADDRESS')
const badgeKey  = getEnv('BADGE_MINTER_KEY')
let needNewBadge = !isValidAddress(badgeAddr) || !isValidPrivKey(badgeKey)
if (needNewBadge) {
  const walletFile = join(WALLET_DIR, 'badge-minter.json')
  let pk, addr
  if (existsSync(walletFile)) {
    const w = JSON.parse(readFileSync(walletFile, 'utf8'))
    pk = w.privateKey
    addr = w.address
    console.log(`BADGE minter: reused ${addr}`)
  } else {
    pk = generatePrivateKey()
    const acct = privateKeyToAccount(pk)
    pk = pk; addr = acct.address
    writeFileSync(walletFile, JSON.stringify({ privateKey: pk, address: addr }, null, 2))
    console.log(`BADGE minter: GENERATED ${addr}  (key in ${walletFile})`)
  }
  setEnv('BADGE_MINTER_ADDRESS', addr, 'Hot wallet — badge-minter.json')
  setEnv('BADGE_MINTER_KEY',     pk,   'Hot wallet — badge-minter.json')
} else {
  console.log(`BADGE minter: present ${badgeAddr}`)
}

// ── 6. Treasury / LP fee sink / NFT rewards — point at deployer for testnet ──
for (const k of ['TREASURY_ADDRESS', 'LP_FEE_SINK_ADDRESS', 'NFT_REWARDS_ADDRESS']) {
  const cur = getEnv(k)
  if (isValidAddress(cur)) {
    console.log(`${k}: present ${cur}`)
  } else {
    setEnv(k, deployer.address, 'Testnet only — single deployer wallet')
    console.log(`${k}: → deployer ${deployer.address}`)
  }
}

writeFileSync(ENV_PATH, lines.join('\n'))
console.log('\n.env patched.\n')

// ── 7. Funding summary ───────────────────────────────────────
console.log('=== Funding required on Base Sepolia ===')
console.log(`  Deployer  ${deployer.address}     — needs ≥ 0.1 ETH (for deploy gas)`)
console.log(`  Keeper    ${getEnv('KEEPER_ADDRESS')}     — needs ≥ 0.05 ETH (recordPrice/settle gas)`)
console.log(`  OracleResolver (post-deploy)    — top up with 0.1 ETH (Pyth fees)`)
console.log('\nFaucets:')
console.log('  ETH:  https://www.alchemy.com/faucets/base-sepolia')
console.log('        https://faucet.quicknode.com/base/sepolia')
console.log('  USDC: https://faucet.circle.com   (select Base Sepolia)')
