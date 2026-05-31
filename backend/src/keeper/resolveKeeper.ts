/**
 * resolveKeeper — Sprint 2.1
 *
 * Walks OPEN markets and batch-settles their ready matches via
 * OracleResolver.resolveOrderbookMarketBatch, capping per-tx settlements so
 * each tx stays under a predictable gas ceiling. Loops per-market until the
 * "ready" queue is drained or a bounded max-loop is hit.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
} from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { pg } from '../db/pg.js'
import { CONTRACTS, PYTH_HERMES } from '../config.js'

const chain = process.env.CHAIN_ID === '8453' ? base : baseSepolia

const ORACLE_RESOLVER_BATCH_ABI = [
  {
    name: 'resolveOrderbookMarketBatch',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'market',          type: 'address' },
      { name: 'priceUpdateData', type: 'bytes[]' },
      { name: 'maxCount',        type: 'uint256' },
    ],
    outputs: [{ name: 'settled', type: 'uint256' }],
  },
] as const

const MARKET_VIEW_ABI = [
  {
    name: 'pythFeedId',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'getReadySettlements',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit',  type: 'uint256' },
    ],
    outputs: [{ type: 'uint256[]' }],
  },
] as const

const publicClient = createPublicClient({
  chain,
  transport: http(process.env.BASE_RPC_URL),
})

/** Per-tx settle ceiling. ~25 matches fits comfortably in 1.5M gas. */
const MAX_PER_TX  = Number(process.env.RESOLVE_MAX_PER_TX ?? '25')
/** Per-market loop cap, prevents runaway. */
const MAX_LOOPS   = Number(process.env.RESOLVE_MAX_LOOPS  ?? '8')

async function pendingMarkets(): Promise<Address[]> {
  const r = await pg.query(`SELECT market_address FROM markets WHERE status = 'OPEN'`)
  return r.rows.map((x) => x.market_address as Address)
}

async function fetchHermesUpdate(feedId: `0x${string}`): Promise<`0x${string}`[]> {
  const url = `${PYTH_HERMES}/v2/updates/price/latest?ids[]=${feedId}&encoding=hex&parsed=false`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`hermes ${r.status}`)
  const j = (await r.json()) as { binary: { data: string[] } }
  return j.binary.data.map((h) => (h.startsWith('0x') ? h : `0x${h}`) as `0x${string}`)
}

export async function settlePendingMarkets() {
  const key = process.env.KEEPER_PRIVATE_KEY as `0x${string}` | undefined
  if (!key) return
  if (!CONTRACTS.ORACLE_RESOLVER || CONTRACTS.ORACLE_RESOLVER === '0x') return

  const account = privateKeyToAccount(key)
  const wallet = createWalletClient({ account, chain, transport: http(process.env.BASE_RPC_URL) })

  const markets = await pendingMarkets()
  for (const market of markets) {
    try {
      // Skim once before doing any tx work — avoid paying RPC for nothing.
      const initialReady = await publicClient.readContract({
        address: market, abi: MARKET_VIEW_ABI,
        functionName: 'getReadySettlements',
        args: [0n, BigInt(MAX_PER_TX)],
      })
      if (initialReady.length === 0) continue

      const feedId = await publicClient.readContract({
        address: market, abi: MARKET_VIEW_ABI, functionName: 'pythFeedId',
      })

      for (let i = 0; i < MAX_LOOPS; i++) {
        const ready = await publicClient.readContract({
          address: market, abi: MARKET_VIEW_ABI,
          functionName: 'getReadySettlements',
          args: [0n, BigInt(MAX_PER_TX)],
        })
        if (ready.length === 0) break

        const updateData = await fetchHermesUpdate(feedId as `0x${string}`)
        const hash = await wallet.writeContract({
          address:      CONTRACTS.ORACLE_RESOLVER as Address,
          abi:          ORACLE_RESOLVER_BATCH_ABI,
          functionName: 'resolveOrderbookMarketBatch',
          args:         [market, updateData, BigInt(MAX_PER_TX)],
          gas:          1_800_000n,
        })
        await publicClient.waitForTransactionReceipt({ hash })
        console.log(`[resolver] ${market} settled ${ready.length} (loop ${i + 1}) tx=${hash}`)
      }
    } catch (err) {
      console.error(`[resolver] market ${market} failed:`, err)
    }
  }
}
