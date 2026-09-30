/**
 * Three fresh throwaway wallets for `rounds-e2e.mts --testnet`, so the end-to-end run does not share nonces
 * with a traffic run (soak-traders.mts) that uses scripts/rhc/.soak-wallets.json.
 *
 *   tsx scripts/rhc/rounds-e2e-wallets.mts                     create the file if missing, print addresses and balances
 *   tsx scripts/rhc/rounds-e2e-wallets.mts --fund --yes-testnet  top the wallets up from the deployer (PRIVATE_KEY in .env)
 *
 * Then: set ROUNDS_E2E_WALLETS_FILE=scripts\rhc\.rounds-e2e-wallets.json  before rounds-e2e.mts.
 * The file is scripts/rhc/.rounds-e2e-wallets.json (*.json is ignored by git). Keys are never printed.
 * Testnet only: any other chain id is refused.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, defineChain, formatEther, http, type Address } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { asKey, readEnvNames, readSoakKeys, TESTNET_ID, TESTNET_RPC } from './rounds-lib.mts'

const here = dirname(fileURLToPath(import.meta.url))
const FILE = join(here, '.rounds-e2e-wallets.json')
const FUND = process.argv.includes('--fund')
const YES = process.argv.includes('--yes-testnet')
// p1, p2, referrer: what rounds-e2e.mts needs (0.0002, 0.0002, 0.00005 ETH) with headroom for a rerun.
const TARGET_WEI = [400_000_000_000_000n, 400_000_000_000_000n, 100_000_000_000_000n]
const NAMES = ['p1', 'p2', 'referrer']

const rpcUrl = process.env.RHC_RPC_URL ?? TESTNET_RPC
if (/mainnet/i.test(rpcUrl)) throw new Error(`refusing an RPC that names mainnet: ${rpcUrl}`)
const chain = defineChain({ id: TESTNET_ID, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } })
const pub = createPublicClient({ chain, transport: http(rpcUrl) })
const id = await pub.getChainId()
if (id !== TESTNET_ID) throw new Error(`chain ${id} is not the testnet ${TESTNET_ID}: refusing`)

if (!existsSync(FILE)) {
  writeFileSync(FILE, JSON.stringify({ keys: [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()] }))
  console.log(`created ${FILE} (three new keys, not printed)`)
}
const keys = readSoakKeys(FILE)
if (keys.length !== 3) throw new Error(`${FILE} must hold exactly three keys`)
const accounts = keys.map((k) => privateKeyToAccount(k))
const soak = new Set(readSoakKeys().map((k) => privateKeyToAccount(k).address))
if (accounts.some((a) => soak.has(a.address))) throw new Error('an e2e wallet is also a soak wallet: delete the file and rerun')

const balances: bigint[] = []
for (const [i, a] of accounts.entries()) {
  const b = await pub.getBalance({ address: a.address })
  balances.push(b)
  console.log(`${NAMES[i]} ${a.address}: ${formatEther(b)} ETH (target ${formatEther(TARGET_WEI[i])})`)
}
if (!FUND) {
  console.log('read only. To top up from the deployer: --fund --yes-testnet')
  process.exit(0)
}
if (!YES) throw new Error('--fund needs --yes-testnet')

const deployer = privateKeyToAccount(asKey(readEnvNames(['PRIVATE_KEY']).PRIVATE_KEY, 'PRIVATE_KEY'))
const wallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) })
console.log(`deployer ${deployer.address}: ${formatEther(await pub.getBalance({ address: deployer.address }))} ETH`)
for (const [i, a] of accounts.entries()) {
  const need = TARGET_WEI[i] - balances[i]
  if (need <= 0n) continue
  const hash = await wallet.sendTransaction({ to: a.address as Address, value: need })
  const rc = await pub.waitForTransactionReceipt({ hash })
  console.log(`funded ${NAMES[i]} +${formatEther(need)} ETH: ${rc.status} ${hash}`)
}
console.log('done')
