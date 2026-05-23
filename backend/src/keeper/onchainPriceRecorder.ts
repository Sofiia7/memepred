import { createPublicClient, createWalletClient, http, type Address } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { FEED_IDS, PYTH_HERMES, ORACLE_RESOLVER_ABI, CONTRACTS } from '../config.js'

const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) })

/**
 * Fetch Pyth Hermes price updates and submit them on-chain to OracleResolver.
 * Must be called by an address with KEEPER_ROLE.
 * Submits with msg.value = pyth.getUpdateFee(); OracleResolver holds an ETH
 * balance for this purpose (top up from treasury).
 */
export async function recordPricesOnChain() {
  const key = process.env.KEEPER_PRIVATE_KEY as `0x${string}` | undefined
  if (!key) { console.warn('KEEPER_PRIVATE_KEY missing — skipping on-chain price record'); return }
  if (!CONTRACTS.ORACLE_RESOLVER || CONTRACTS.ORACLE_RESOLVER === '0x') {
    console.warn('ORACLE_RESOLVER address missing'); return
  }

  const account = privateKeyToAccount(key)
  const wallet  = createWalletClient({ account, chain: base, transport: http(process.env.BASE_RPC_URL) })

  for (const [symbol, feedId] of Object.entries(FEED_IDS)) {
    try {
      // Hermes binary VAA endpoint (v2/updates/price/latest).
      const url = `${PYTH_HERMES}/v2/updates/price/latest?ids[]=${feedId}&encoding=hex&parsed=false`
      const r   = await fetch(url)
      if (!r.ok) throw new Error(`hermes ${r.status}`)
      const json = await r.json() as { binary: { data: string[] } }
      const updateData = json.binary.data.map(h => (h.startsWith('0x') ? h : `0x${h}`) as `0x${string}`)

      const hash = await wallet.writeContract({
        address:      CONTRACTS.ORACLE_RESOLVER as Address,
        abi:          ORACLE_RESOLVER_ABI,
        functionName: 'recordPrice',
        args:         [feedId as `0x${string}`, updateData],
        value:        0n  // OracleResolver pays Pyth from its own ETH balance
      })
      await publicClient.waitForTransactionReceipt({ hash })
    } catch (err) {
      console.error(`on-chain recordPrice ${symbol} failed:`, err)
    }
  }
}
