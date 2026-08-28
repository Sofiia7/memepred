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
  encodeFunctionData,
  http,
  type Address,
} from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { pg } from '../db/pg.js'
import { CONTRACTS } from '../config.js'
import { fetchPayload, withPayload, bytes32ToFeedId } from '../lib/redstone.js'
import { getKeeperWalletClient } from './keeperWallet.js'
import { gasGuard, recordReceipt } from './gasGuardInstance.js'

const chain = process.env.CHAIN_ID === '8453' ? base : baseSepolia

const ORACLE_RESOLVER_BATCH_ABI = [
  {
    name: 'resolveOrderbookMarketBatch',
    type: 'function',
    stateMutability: 'nonpayable',
    // The price is a calldata suffix, not an argument.
    inputs: [
      { name: 'market',   type: 'address' },
      { name: 'maxCount', type: 'uint256' },
    ],
    outputs: [{ name: 'settled', type: 'uint256' }],
  },
] as const

const MARKET_VIEW_ABI = [
  {
    name: 'feedId',
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

/**
 * Markets that have at least one match actually ready to settle.
 *
 * Sprint 5.6 — was `WHERE status = 'OPEN'`, which could never settle anything.
 *
 * A market's close_time is open_time + duration: the point after which it
 * stops accepting new bets. A match's settle_at is matched_at + duration.
 * Since every match is created after its market opened, settle_at is ALWAYS
 * later than close_time — by exactly however long the market had been open
 * when the match formed. Meanwhile marketCreator.closeExpiredMarkets() flips
 * the row to 'CLOSED' at close_time. So by the time any match became ready,
 * its market had already left the set this query returned, and the keeper
 * settled nothing, ever. Funds sat until SETTLE_GRACE (24h) expired and then
 * could only be emergency-refunded.
 *
 * Confirmed on-chain 2026-07-25: market opened 18:00:42, closed 18:05:42,
 * its only match matched at 18:02:48 and was due at 18:07:48 — two minutes
 * after the market stopped being 'OPEN'.
 *
 * The correct predicate has nothing to do with whether a market still takes
 * bets: settle the markets that own an unsettled, due match. The upper bound
 * skips matches already past SETTLE_GRACE, where the contract reverts with
 * "settlement window expired" — those are refundExpired's job, and retrying
 * them would burn gas forever.
 */
const SETTLE_GRACE_HOURS = Number(process.env.SETTLE_GRACE_HOURS ?? '24')

async function pendingMarkets(): Promise<Address[]> {
  const r = await pg.query(`
    SELECT DISTINCT mt.market_address
    FROM matches mt
    WHERE mt.settled = FALSE
      AND mt.settle_at <= NOW()
      AND mt.settle_at >  NOW() - make_interval(hours => $1)
  `, [SETTLE_GRACE_HOURS])
  return r.rows.map((x) => x.market_address as Address)
}

/**
 * The signed price for a market's feed, as a calldata suffix.
 *
 * The market stores its feed as a bytes32 symbol, which is also the gateway's
 * key, so the trailing zero padding is stripped back off to look it up.
 */
async function fetchOraclePayload(feedId: `0x${string}`): Promise<string> {
  const symbol = Buffer.from(feedId.slice(2), 'hex').toString('utf8').replace(/\u0000+$/, '')
  return fetchPayload(symbol)
}

export async function settlePendingMarkets() {
  const wallet = getKeeperWalletClient()
  if (!wallet) return
  if (!CONTRACTS.ORACLE_RESOLVER || CONTRACTS.ORACLE_RESOLVER === '0x') return

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
        address: market, abi: MARKET_VIEW_ABI, functionName: 'feedId',
      })

      for (let i = 0; i < MAX_LOOPS; i++) {
        const ready = await publicClient.readContract({
          address: market, abi: MARKET_VIEW_ABI,
          functionName: 'getReadySettlements',
          args: [0n, BigInt(MAX_PER_TX)],
        })
        if (ready.length === 0) break

        const payload = await fetchOraclePayload(feedId as `0x${string}`)
        const settleCallData = withPayload(
          encodeFunctionData({
            abi:          ORACLE_RESOLVER_BATCH_ABI,
            functionName: 'resolveOrderbookMarketBatch',
            args:         [market, BigInt(MAX_PER_TX)],
          }),
          payload,
        )

        // Simulate first. Gas is pinned at 1.8M below, so a revert burns the
        // entire 1.8M — and this loop runs every 60s and retries MAX_LOOPS
        // times, because `ready` is still non-empty after a failed settle.
        // That turns one recurring revert into ~14.4M wasted gas per minute,
        // indefinitely. Measured on Sepolia at ~0.0044 ETH/hour before this
        // check existed.
        //
        // Unlike the Pyth push in onchainPriceRecorder, there is no known
        // benign revert here, so a failed simulation genuinely means "don't
        // send". The common real cause is a young deployment whose
        // OracleResolver.priceHistory has too few points for _getTWAP to cover
        // the window — legitimate, transient, and exactly what should not cost
        // 1.8M gas a minute to rediscover.
        try {
          // publicClient.call rather than simulateContract: the latter encodes
          // the call itself, leaving nowhere to append the signed price, so it
          // would simulate a call the chain would never see and always revert.
          await publicClient.call({
            account: wallet.account,
            to:      CONTRACTS.ORACLE_RESOLVER as Address,
            data:    settleCallData,
          })
        } catch (simErr: any) {
          console.warn(
            `[resolver] ${market}: settle would revert, skipping ` +
            `(${simErr?.shortMessage ?? simErr?.message ?? 'unknown'})`,
          )
          break
        }

        // Critical: never blocked by the fee ceiling or the daily budget.
        // Somebody's stake is sitting in a market that already resolved, and
        // no gas price makes leaving it there the cheaper option. The call is
        // here for the warning it logs and for the spend accounting below.
        await gasGuard.check('critical')

        const hash = await wallet.sendTransaction({
          to:   CONTRACTS.ORACLE_RESOLVER as Address,
          data: settleCallData,
          gas:  1_800_000n,
        })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        await recordReceipt(receipt)

        // waitForTransactionReceipt resolves for reverted transactions too —
        // it waits for inclusion, not for success. Without this check the loop
        // logged "settled N" for a transaction that settled nothing, then
        // retried it MAX_LOOPS times.
        if (receipt.status !== 'success') {
          console.error(`[resolver] ${market}: settle tx reverted on-chain, tx=${hash}`)
          break
        }
        console.log(`[resolver] ${market} settled ${ready.length} (loop ${i + 1}) tx=${hash}`)
      }
    } catch (err) {
      console.error(`[resolver] market ${market} failed:`, err)
    }
  }
}
