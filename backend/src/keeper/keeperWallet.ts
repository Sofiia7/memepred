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
import { createPublicClient, createWalletClient, http, nonceManager } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { NonceEscalation, isStuckNonceError, shouldCancelNonce, type Fees } from './feeEscalator.js'

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


// ── SENDING, AND GETTING UNWEDGED ─────────────────────────────────────
/**
 * nonceManager solved loops colliding on the same nonce. It does not solve a
 * transaction that occupies a nonce and never mines, which is what happened on
 * 2026-08-28: a fee spike stranded one transaction at 0.007 gwei, everything
 * queued behind it, and every retry was rejected as an underpriced replacement
 * because viem re-quoted the same price each time. The keeper sat wedged for
 * over an hour and could not have recovered on its own.
 *
 * sendKeeperTx bids higher when it sees that error, and only that error. See
 * feeEscalator.ts for why it is keyed on the nonce and why the other failures
 * must not escalate.
 */
const publicClient = createPublicClient({ chain, transport: http(process.env.BASE_RPC_URL) })

const escalation = new NonceEscalation()

/** Immediate retries per call. The counter persists, so successive keeper
 *  ticks keep climbing rather than restarting from the base quote. */
const RETRIES_PER_CALL = 3
/** 1.25^12 is ~14.6x the quote - enough to displace anything a spike stranded,
 *  still bounded by the pinned per-transaction gas limits. */
const MAX_ESCALATIONS = 12

/**
 * Displace whatever is sitting on `nonce` with an empty self-transfer.
 *
 * The escape hatch for when bidding up the real transaction stops being
 * affordable. 21,000 gas against the 500,000-1,800,000 the keeper's real work
 * pins means the same wallet can outbid a stranded transaction at roughly 40x
 * the fee it could attach to the work itself. Nothing moves but gas: value is
 * zero and the recipient is the sender.
 */
async function displaceNonce(nonce: number, fees: Fees): Promise<boolean> {
  const wallet  = getKeeperWalletClient()
  const account = getKeeperAccount()
  if (!wallet || !account) return false

  try {
    const hash = await wallet.sendTransaction({
      to:    account.address,
      value: 0n,
      gas:   21_000n,
      nonce, // explicit, bypassing nonceManager - displacing this exact nonce
             // is the entire point of the call
      ...fees,
    })
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`[keeperWallet] displaced stuck nonce ${nonce} with an empty transfer, tx=${hash}`)
    // Let nonceManager re-read from the chain rather than trust its cache.
    nonceManager.reset({ address: account.address, chainId: chain.id })
    return true
  } catch (err) {
    console.warn(`[keeperWallet] could not displace nonce ${nonce}: ${String((err as Error).message).split(String.fromCharCode(10))[0]}`)
    return false
  }
}

/**
 * Run `send` with escalating fees. `send` receives the fees to use and does the
 * actual writeContract/sendTransaction; the nonce is still left to viem's
 * nonceManager.
 */
export async function sendKeeperTx(
  send: (fees: Fees) => Promise<`0x${string}`>,
  label: string,
): Promise<`0x${string}`> {
  const account = getKeeperAccount()
  if (!account) throw new Error('KEEPER_PRIVATE_KEY missing')

  const quoted = await publicClient.estimateFeesPerGas()
  const base: Fees = {
    maxFeePerGas:         quoted.maxFeePerGas,
    maxPriorityFeePerGas: quoted.maxPriorityFeePerGas,
  }
  // Read only to key the escalation counter - the transaction itself still
  // gets its nonce from nonceManager.
  const nonce = await publicClient.getTransactionCount({ address: account.address })

  let lastErr: unknown
  for (let i = 0; i <= RETRIES_PER_CALL; i++) {
    const fees = escalation.next(nonce, base)
    try {
      const hash = await send(fees)
      if (escalation.level > 0) {
        console.log(`[keeperWallet] ${label}: unwedged nonce ${nonce} at ${Number(fees.maxFeePerGas) / 1e9} gwei`)
      }
      escalation.succeeded()
      return hash
    } catch (err) {
      lastErr = err
      if (!isStuckNonceError(err)) throw err
      const level = escalation.bump(nonce)
      console.warn(
        `[keeperWallet] ${label}: nonce ${nonce} occupied, raising the bid ` +
        `(attempt ${level}, ${Number(escalation.next(nonce, base).maxFeePerGas) / 1e9} gwei)`,
      )
      // Past a few tries the real transaction is too heavy to outbid; displace
      // the nonce with 21,000 gas instead and let the caller try again.
      if (shouldCancelNonce(level) && await displaceNonce(nonce, escalation.next(nonce, base))) {
        escalation.succeeded()
        continue
      }
      if (level >= MAX_ESCALATIONS) {
        console.error(`[keeperWallet] ${label}: nonce ${nonce} still wedged after ${level} escalations - giving up this tick`)
        throw err
      }
    }
  }
  throw lastErr
}

/** Exposed so the watchdog can publish a wedged nonce instead of leaving an
 *  operator to infer it from a keeper that has simply gone quiet. */
export function escalationState(): { stuckNonce: number | null; level: number } {
  return { stuckNonce: escalation.stuckNonce, level: escalation.level }
}
