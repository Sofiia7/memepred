import { createPublicClient, createWalletClient, http, type Address } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { pg } from '../db/pg.js'
import { CONTRACTS, PYTH_HERMES } from '../config.js'

const ORACLE_RESOLVER_RESOLVE_ABI = [
  {
    name: 'resolveOrderbookMarket',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'market',          type: 'address' },
      { name: 'priceUpdateData', type: 'bytes[]' }
    ],
    outputs: []
  }
] as const

const MARKET_ABI_FEED = [
  {
    name: 'pythFeedId',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }]
  },
  {
    name: 'getPendingSettlements',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256[]' }]
  }
] as const

const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) })

async function pendingMarkets(): Promise<Address[]> {
  const r = await pg.query(`
    SELECT market_address FROM markets WHERE status = 'OPEN'
  `)
  return r.rows.map(x => x.market_address as Address)
}

async function fetchHermesUpdate(feedId: `0x${string}`): Promise<`0x${string}`[]> {
  const url = `${PYTH_HERMES}/v2/updates/price/latest?ids[]=${feedId}&encoding=hex&parsed=false`
  const r   = await fetch(url)
  if (!r.ok) throw new Error(`hermes ${r.status}`)
  const j   = await r.json() as { binary: { data: string[] } }
  return j.binary.data.map(h => (h.startsWith('0x') ? h : `0x${h}`) as `0x${string}`)
}

/**
 * Walk OPEN markets, check if they have mature pending settlements, and
 * call OracleResolver.resolveOrderbookMarket() for each.
 */
export async function settlePendingMarkets() {
  const key = process.env.KEEPER_PRIVATE_KEY as `0x${string}` | undefined
  if (!key) return
  if (!CONTRACTS.ORACLE_RESOLVER || CONTRACTS.ORACLE_RESOLVER === '0x') return

  const account = privateKeyToAccount(key)
  const wallet  = createWalletClient({ account, chain: base, transport: http(process.env.BASE_RPC_URL) })

  const markets = await pendingMarkets()
  for (const market of markets) {
    try {
      const pending = await publicClient.readContract({
        address: market, abi: MARKET_ABI_FEED, functionName: 'getPendingSettlements'
      })
      if (pending.length === 0) continue

      const feedId = await publicClient.readContract({
        address: market, abi: MARKET_ABI_FEED, functionName: 'pythFeedId'
      })
      const updateData = await fetchHermesUpdate(feedId as `0x${string}`)

      const hash = await wallet.writeContract({
        address:      CONTRACTS.ORACLE_RESOLVER as Address,
        abi:          ORACLE_RESOLVER_RESOLVE_ABI,
        functionName: 'resolveOrderbookMarket',
        args:         [market, updateData]
      })
      await publicClient.waitForTransactionReceipt({ hash })
      console.log(`Settled ${pending.length} matches on ${market} via ${hash}`)
    } catch (err) {
      console.error(`Failed to settle market ${market}:`, err)
    }
  }
}
