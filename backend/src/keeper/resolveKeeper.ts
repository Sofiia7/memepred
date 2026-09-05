import { CHAIN_PROFILE } from '../chainProfile.js'
/**
 * resolveKeeper — Sprint 2.1
 *
 * Walks OPEN markets and batch-settles their ready matches via
 * OracleResolver.resolveOrderbookMarketBatchFrom, capping per-tx settlements so
 * each tx stays under a predictable gas ceiling. Loops per-market until the
 * "ready" queue is drained or a bounded max-loop is hit, stepping the read
 * offset past any window the resolver declines to settle.
 */
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  type Address,
} from 'viem'
import { pg } from '../db/pg.js'
import { CONTRACTS } from '../config.js'
import { fetchPayload, withPayload, bytes32ToFeedId } from '../lib/redstone.js'
import { getKeeperWalletClient, sendKeeperTx } from './keeperWallet.js'
import { gasGuard, recordReceipt } from './gasGuardInstance.js'
import { BATCH_FROM_SELECTOR, codeHasSelector } from './resolverAbi.js'

const chain = CHAIN_PROFILE.chain

const ORACLE_RESOLVER_BATCH_ABI = [
  {
    // Takes an offset past the queue head. The head only advances over matches
    // that actually settled, so one ready-but-unsettleable match at the front
    // pins the window and hides everything behind it; walking the offset is how
    // the rest stays reachable.
    name: 'resolveOrderbookMarketBatchFrom',
    type: 'function',
    stateMutability: 'nonpayable',
    // The price is a calldata suffix, not an argument.
    inputs: [
      { name: 'market',   type: 'address' },
      { name: 'offset',   type: 'uint256' },
      { name: 'maxCount', type: 'uint256' },
    ],
    outputs: [{ name: 'settled', type: 'uint256' }],
  },
  {
    // The pre-pagination entrypoint, still what is deployed today. Kept so the
    // keeper can ship ahead of the contract redeploy instead of waiting on it.
    name: 'resolveOrderbookMarketBatch',
    type: 'function',
    stateMutability: 'nonpayable',
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
  transport: http(CHAIN_PROFILE.rpcUrl),
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

/**
 * Whether the deployed resolver has the paginating entrypoint.
 *
 * Cached for the life of the process: the answer only changes on a redeploy,
 * and the keeper restarts for those.
 */
let paginates: boolean | undefined

async function resolverPaginates(): Promise<boolean> {
  if (paginates !== undefined) return paginates
  const code = await publicClient.getCode({ address: CONTRACTS.ORACLE_RESOLVER as Address })
  paginates = codeHasSelector(code, BATCH_FROM_SELECTOR)
  if (!paginates) {
    console.warn(
      '[resolver] deployed resolver predates resolveOrderbookMarketBatchFrom - ' +
      'settling from the queue head only. A match that cannot settle will hold ' +
      'up the ones behind it until the contracts are redeployed.',
    )
  }
  return paginates
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
      const canPaginate = await resolverPaginates()

      // Where this tick is reading from, counted past the queue head.
      //
      // The head only advances over matches that actually settled. A match at
      // the front that is ready but cannot settle - unpriceable after a long
      // outage, or repeatedly over the spread guard - therefore pins the window
      // and hides everything behind it. Re-reading offset 0 every loop is what
      // turned that into a standstill; stepping past a window that settles
      // nothing is what keeps the rest reachable.
      let offset = 0n

      for (let i = 0; i < MAX_LOOPS; i++) {
        const ready = await publicClient.readContract({
          address: market, abi: MARKET_VIEW_ABI,
          functionName: 'getReadySettlements',
          args: [canPaginate ? offset : 0n, BigInt(MAX_PER_TX)],
        })
        if (ready.length === 0) break

        const payload = await fetchOraclePayload(feedId as `0x${string}`)
        const settleCallData = withPayload(
          canPaginate
            ? encodeFunctionData({
                abi:          ORACLE_RESOLVER_BATCH_ABI,
                functionName: 'resolveOrderbookMarketBatchFrom',
                args:         [market, offset, BigInt(MAX_PER_TX)],
              })
            : encodeFunctionData({
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
        let wouldSettle: bigint
        try {
          // publicClient.call rather than simulateContract: the latter encodes
          // the call itself, leaving nowhere to append the signed price, so it
          // would simulate a call the chain would never see and always revert.
          const sim = await publicClient.call({
            account: wallet.account,
            to:      CONTRACTS.ORACLE_RESOLVER as Address,
            data:    settleCallData,
          })
          // The batch returns how many it settled. Reading it here is what
          // separates "this window has work" from "this window has matches the
          // resolver will skip" - the two used to be indistinguishable, so a
          // skipped window was re-sent MAX_LOOPS times and logged as a
          // successful settle of `ready.length` matches every time.
          wouldSettle = decodeFunctionResult({
            abi:          ORACLE_RESOLVER_BATCH_ABI,
            functionName: canPaginate
              ? 'resolveOrderbookMarketBatchFrom'
              : 'resolveOrderbookMarketBatch',
            data:         sim.data ?? '0x',
          }) as bigint
        } catch (simErr: any) {
          console.warn(
            `[resolver] ${market}: settle would revert, skipping ` +
            `(${simErr?.shortMessage ?? simErr?.message ?? 'unknown'})`,
          )
          break
        }

        if (wouldSettle === 0n && !canPaginate) {
          // No way to step past this window on the deployed resolver. Stop
          // rather than re-send a batch that settles nothing MAX_LOOPS times.
          console.warn(
            `[resolver] ${market}: ${ready.length} ready match(es) cannot settle yet ` +
            `and this resolver cannot page past them`,
          )
          break
        }

        if (wouldSettle === 0n) {
          // Every match in this window is one the resolver declines to settle
          // right now. Sending would cost a full gas ceiling to accomplish
          // nothing; step past them instead so anything behind is reachable.
          // They stay in the queue, and become refundable by anyone once
          // SETTLE_GRACE lapses.
          console.warn(
            `[resolver] ${market}: ${ready.length} ready match(es) at offset ${offset} ` +
            `cannot settle yet - stepping past them`,
          )
          offset += BigInt(MAX_PER_TX)
          continue
        }

        // Critical: never blocked by the fee ceiling or the daily budget.
        // Somebody's stake is sitting in a market that already resolved, and
        // no gas price makes leaving it there the cheaper option. The call is
        // here for the warning it logs and for the spend accounting below.
        await gasGuard.check('critical')

        const hash = await sendKeeperTx(fees => wallet.sendTransaction({
          to:   CONTRACTS.ORACLE_RESOLVER as Address,
          data: settleCallData,
          gas:  1_800_000n,
          ...fees,
        }), 'settle')
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        await recordReceipt(receipt, 'critical')

        // waitForTransactionReceipt resolves for reverted transactions too —
        // it waits for inclusion, not for success. Without this check the loop
        // logged "settled N" for a transaction that settled nothing, then
        // retried it MAX_LOOPS times.
        if (receipt.status !== 'success') {
          console.error(`[resolver] ${market}: settle tx reverted on-chain, tx=${hash}`)
          break
        }
        // The count the resolver reported, not the number that looked ready.
        console.log(`[resolver] ${market} settled ${wouldSettle} (loop ${i + 1}) tx=${hash}`)
        // The head has moved past what just settled, so read from it again.
        offset = 0n
      }
    } catch (err) {
      console.error(`[resolver] market ${market} failed:`, err)
    }
  }
}
