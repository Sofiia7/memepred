/** Deploy the redeemable testnet stake token, then prove deposit and withdraw.
 *  Only Robinhood Chain testnet (46630); the private key is read without logging.
 *  Run after `forge build`: tsx scripts/rhc/deploy-test-weth.mts --yes-testnet
 */
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { artifact, asKey, readEnvNames, TESTNET_ID, TESTNET_RPC } from './rounds-lib.mts'

if (!process.argv.includes('--yes-testnet')) throw new Error('Add --yes-testnet to send testnet transactions')
const chain = defineChain({ id: TESTNET_ID, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [TESTNET_RPC] } } })
const pub = createPublicClient({ chain, transport: http(TESTNET_RPC) })
if (await pub.getChainId() !== TESTNET_ID) throw new Error('Wrong chain')
const vars = readEnvNames(['PRIVATE_KEY'])
const account = privateKeyToAccount(asKey(process.env.PRIVATE_KEY ?? vars.PRIVATE_KEY, 'PRIVATE_KEY'))
const wallet = createWalletClient({ account, chain, transport: http(TESTNET_RPC) })
const a = artifact('TestWETH.sol/TestWETH.json')
const deployed = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode })
const receipt = await pub.waitForTransactionReceipt({ hash: deployed, timeout: 180_000 })
if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`Deployment failed: ${deployed}`)
const address = receipt.contractAddress
const abi = parseAbi(['function deposit() payable', 'function withdraw(uint256)', 'function balanceOf(address) view returns (uint256)'])
const deposit = await wallet.writeContract({ address, abi, functionName: 'deposit', value: 1n })
if ((await pub.waitForTransactionReceipt({ hash: deposit })).status !== 'success') throw new Error('Deposit failed')
if (await pub.readContract({ address, abi, functionName: 'balanceOf', args: [account.address] }) !== 1n) throw new Error('Deposit did not mint one wei')
const withdraw = await wallet.writeContract({ address, abi, functionName: 'withdraw', args: [1n] })
if ((await pub.waitForTransactionReceipt({ hash: withdraw })).status !== 'success') throw new Error('Withdrawal failed')
if (await pub.readContract({ address, abi, functionName: 'balanceOf', args: [account.address] }) !== 0n) throw new Error('Withdrawal did not burn one wei')
console.log(`TestWETH=${address}`)
console.log(`deployment block=${receipt.blockNumber} tx=${deployed}`)
console.log(`deposit/withdraw 1 wei: OK; tx=${deposit}, ${withdraw}`)
