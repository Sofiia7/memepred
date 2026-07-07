/**
 * Shared keeper account/wallet client.
 *
 * All keeper loops (onchainPriceRecorder, marketCreator, resolveKeeper,
 * refundExpired) send transactions from the SAME EOA (KEEPER_PRIVATE_KEY) on
 * independent timers (backend/src/keeper/index.ts). Before this module
 * existed, each loop called `privateKeyToAccount(key)` fresh on every tick,
 * so viem fetched a brand-new "pending" nonce per call with no coordination
 * across loops. When two loops happened to submit within the same window
 * (e.g. onchainPriceRecorder and resolveKeeper both firing near the same
 * 30s/60s boundary), they'd both fetch the same nonce and the second
 * submission failed with "replacement transaction underpriced" -- not a gas
 * problem, a nonce collision. Found 2026-07-06 once the keeper wallet was
 * actually funded and started sending real transactions.
 *
 * Fix: one account, attached to viem's built-in `nonceManager` (keyed by
 * address+chainId, not by which Account/WalletClient object references it),
 * shared by every keeper module that sends a transaction. viem's nonceManager
 * serializes concurrent nonce consumption for the same account so loops that
 * fire close together queue instead of colliding.
 */
import { createWalletClient, http, nonceManager } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'

const chain = process.env.CHAIN_ID === '8453' ? base : baseSepolia

// Precise inferred types (not the loose `WalletClient` alias) so call sites
// don't need to re-supply `chain`/`account` per writeContract call.
type KeeperWalletClient = ReturnType<typeof createWalletClient<
  ReturnType<typeof http>,
  typeof chain,
  PrivateKeyAccount
>>

let cachedAccount: PrivateKeyAccount | null = null
let cachedWallet: KeeperWalletClient | null = null

/** Lazily creates (once) and returns the shared keeper account. */
export function getKeeperAccount(): PrivateKeyAccount | null {
  const key = process.env.KEEPER_PRIVATE_KEY as `0x${string}` | undefined
  if (!key) return null
  if (!cachedAccount) {
    cachedAccount = privateKeyToAccount(key, { nonceManager })
  }
  return cachedAccount
}

/** Lazily creates (once) and returns the shared keeper wallet client. */
export function getKeeperWalletClient(): KeeperWalletClient | null {
  const account = getKeeperAccount()
  if (!account) return null
  if (!cachedWallet) {
    cachedWallet = createWalletClient({ account, chain, transport: http(process.env.BASE_RPC_URL) })
  }
  return cachedWallet
}
