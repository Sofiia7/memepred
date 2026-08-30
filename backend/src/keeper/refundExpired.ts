import { createPublicClient, http, type Address } from 'viem'
import { base, baseSepolia } from 'viem/chains'
const chain = process.env.CHAIN_ID === '8453' ? base : baseSepolia
import { pg } from '../db/pg.js'
import { getKeeperWalletClient, sendKeeperTx } from './keeperWallet.js'
import { gasGuard, recordReceipt } from './gasGuardInstance.js'
import { isRefundable } from './refundEligibility.js'

const ORDERBOOK_MARKET_ABI = [
  {
    name: 'getOrder',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'orderId', type: 'uint256' }],
    // The full 11-field Order struct. This was still the pre-multi-fill
    // 8-field shape, which decodes every field after `amount` from the wrong
    // slot - the frontend hit the same thing and was fixed; this copy was not.
    outputs: [{
      name: '',
      type: 'tuple',
      components: [
        { name: 'trader',             type: 'address' },
        { name: 'direction',          type: 'uint8'   },
        { name: 'amount',             type: 'uint256' },
        { name: 'filledAmount',       type: 'uint256' },
        { name: 'referrer',           type: 'address' },
        { name: 'status',             type: 'uint8'   },
        { name: 'placedAt',           type: 'uint256' },
        { name: 'matchId',            type: 'uint256' },
        { name: 'pendingSettlements', type: 'uint256' },
        { name: 'payout',             type: 'uint256' },
        { name: 'unmatchedRefunded',  type: 'bool'    }
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

const publicClient = createPublicClient({
  chain,
  transport: http(process.env.BASE_RPC_URL)
})

/**
 * How far back to keep looking for unreturned stake after a market closes.
 *
 * An order becomes refundable at placedAt + MATCH_TIMEOUT (5 min), which for a
 * 5-minute market always falls *after* close_time - and closeExpiredMarkets
 * flips the row to CLOSED within 30s of that. Scanning `status = 'OPEN'` alone
 * therefore never saw a 5-minute market's expired orders at all, and 5-minute
 * markets are most of them. The contract puts no deadline on refundExpired, so
 * the only reason to stop looking is cost; a day is far past the point where a
 * user would have used the button in the UI themselves.
 */
const REFUND_LOOKBACK = '24 hours'

/** Orders scanned per market per tick. Truncation is logged, never silent. */
const MAX_SCAN_PER_MARKET = 500n

/**
 * Scan orders on recent markets and return stake that never found a match.
 * Called every 5 minutes by the keeper.
 */
export async function refundExpiredOrders() {
  const walletClient = getKeeperWalletClient()
  if (!walletClient) {
    console.error('KEEPER_PRIVATE_KEY not set, skipping refund')
    return
  }

  const result = await pg.query(
    `SELECT DISTINCT market_address FROM markets
      WHERE status = 'OPEN' OR close_time > NOW() - INTERVAL '${REFUND_LOOKBACK}'`
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

      const startId = nextOrderId > MAX_SCAN_PER_MARKET
        ? nextOrderId - MAX_SCAN_PER_MARKET
        : 1n
      if (startId > 1n) {
        console.warn(
          `refundExpired: ${marketAddress} has ${nextOrderId - 1n} orders, ` +
          `scanning the newest ${MAX_SCAN_PER_MARKET}; ` +
          `orders 1..${startId - 1n} are left to the refund button in the UI`
        )
      }

      for (let orderId = startId; orderId < nextOrderId; orderId++) {
        try {
          const order = await publicClient.readContract({
            address:      marketAddress,
            abi:          ORDERBOOK_MARKET_ABI,
            functionName: 'getOrder',
            args:         [orderId]
          })

          if (isRefundable(order, now, matchTimeout)) {
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
            await recordReceipt(receipt, 'critical')
            if (receipt.status !== 'success') {
              console.error(`  refund tx reverted: ${hash}`)
            } else {
              console.log(`  tx: ${hash}`)
            }
          }
        } catch (err) {
          // Deliberately not silent. An empty catch here is what would have
          // hidden the stale getOrder ABI: every read throwing, the whole
          // refund path dead, and nothing in the logs to say so. Short message
          // only, since this runs per order per market every 5 minutes.
          const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
          console.warn(`  order #${orderId} on ${marketAddress}: ${msg}`)
        }
      }
    } catch (err) {
      console.error(`Failed to process market ${marketAddress}:`, err)
    }
  }
}
