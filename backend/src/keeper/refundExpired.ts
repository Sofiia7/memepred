import { createPublicClient, http, type Address } from 'viem'
import { base, baseSepolia } from 'viem/chains'
const chain = process.env.CHAIN_ID === '8453' ? base : baseSepolia
import { pg } from '../db/pg.js'
import { getKeeperWalletClient, sendKeeperTx } from './keeperWallet.js'
import { gasGuard, recordReceipt } from './gasGuardInstance.js'

const ORDERBOOK_MARKET_ABI = [
  {
    name: 'getOrder',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'orderId', type: 'uint256' }],
    outputs: [{
      name: '',
      type: 'tuple',
      components: [
        { name: 'trader',    type: 'address' },
        { name: 'direction', type: 'uint8'   },
        { name: 'amount',    type: 'uint256' },
        { name: 'referrer',  type: 'address' },
        { name: 'status',    type: 'uint8'   },
        { name: 'placedAt',  type: 'uint256' },
        { name: 'matchId',   type: 'uint256' },
        { name: 'payout',    type: 'uint256' }
      ]
    }]
  },
  {
    name: 'nextOrderId',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'refundExpired',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'orderId', type: 'uint256' }],
    outputs: []
  },
  {
    name: 'MATCH_TIMEOUT',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  }
] as const

const ORDER_STATUS_PENDING = 0

const publicClient = createPublicClient({
  chain,
  transport: http(process.env.BASE_RPC_URL)
})

/**
 * Scan pending orders on active markets and refund expired ones.
 * Called every 5 minutes by the keeper.
 */
export async function refundExpiredOrders() {
  const walletClient = getKeeperWalletClient()
  if (!walletClient) {
    console.error('KEEPER_PRIVATE_KEY not set, skipping refund')
    return
  }

  // Get active market addresses from DB
  const result = await pg.query(
    "SELECT DISTINCT market_address FROM markets WHERE status = 'OPEN'"
  )

  for (const row of result.rows) {
    const marketAddress = row.market_address as Address

    try {
      const nextOrderId = await publicClient.readContract({
        address:      marketAddress,
        abi:          ORDERBOOK_MARKET_ABI,
        functionName: 'nextOrderId'
      })

      const now = BigInt(Math.floor(Date.now() / 1000))
      const matchTimeout = await publicClient.readContract({
        address:      marketAddress,
        abi:          ORDERBOOK_MARKET_ABI,
        functionName: 'MATCH_TIMEOUT'
      })

      // Check recent orders (last 100)
      const startId = nextOrderId > 100n ? nextOrderId - 100n : 1n
      for (let orderId = startId; orderId < nextOrderId; orderId++) {
        try {
          const order = await publicClient.readContract({
            address:      marketAddress,
            abi:          ORDERBOOK_MARKET_ABI,
            functionName: 'getOrder',
            args:         [orderId]
          })

          // If PENDING and expired
          if (
            order.status === ORDER_STATUS_PENDING &&
            now > BigInt(order.placedAt) + matchTimeout
          ) {
            console.log(`Refunding expired order #${orderId} on ${marketAddress}`)
            // Critical: this is returning a user's own stake after their order
            // failed to match. Gas price is not a reason to hold onto it.
            await gasGuard.check('critical')

            const hash = await sendKeeperTx(fees => walletClient.writeContract({
              address:      marketAddress,
              abi:          ORDERBOOK_MARKET_ABI,
              functionName: 'refundExpired',
              args:         [orderId],
              ...fees,
            }), 'refundExpired')
            // Waited on so the spend is billed from the receipt rather than
            // guessed, and so a reverted refund stops being invisible.
            const receipt = await publicClient.waitForTransactionReceipt({ hash })
            await recordReceipt(receipt)
            if (receipt.status !== 'success') {
              console.error(`  refund tx reverted: ${hash}`)
            } else {
              console.log(`  tx: ${hash}`)
            }
          }
        } catch (err) {
          // Order might not exist or already refunded
        }
      }
    } catch (err) {
      console.error(`Failed to process market ${marketAddress}:`, err)
    }
  }
}
