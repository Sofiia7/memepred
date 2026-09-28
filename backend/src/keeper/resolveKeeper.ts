import { CHAIN_PROFILE } from '../chainProfile.js'
/**
 * resolveKeeper - Sprint 2.1
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
import { settlementGasLimit, RHC_SETTLEMENT_GAS } from './settlementGas.js'

const chain = CHAIN_PROFILE.chain

const MARKET_REFUND_ABI = [
  {
    name: 'emergencyRefundMatch',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'matchId', type: 'uint256' }],
    outputs: [],
  },
] as const

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
 * Where each market's settlement scan last confirmed a stuck window ended,
 * carried across ticks.
 *
 * Audit A08 (2026-09-28): offset used to start at 0n on every call to
 * settlePendingMarkets, bounding total progress past a stuck run to
 * MAX_LOOPS*MAX_PER_TX positions PER TICK, forever - a run longer than that
 * (an entire pool gone to zero liquidity produces many consecutive
 * unpriceable matches, not just one) was never fully walked past: newer,
 * perfectly settleable matches behind it sat until SETTLE_GRACE and a 24h
 * emergency refund instead of a normal, priced settlement. Remembering how
 * far the walk had already reached lets each new tick jump straight there
 * instead of re-discovering the same prefix one window at a time.
 *
 * In-process only, not persisted to the DB: a keeper restart re-discovers the
 * same stuck run at the same bounded per-tick cost this always had: it just
 * no longer repeats that discovery on every single tick forever. Self-heals
 * if the stuck window clears (a belated settle, or the emergency-refund sweep
 * finally clearing the head) because iteration 0 of every tick still checks
 * offset 0 first - see its use below - and any successful settle resets the
 * saved value back to 0.
 */
const lastOffset = new Map<Address, bigint>()

/**
 * Where to resume scanning after finding the window at `current` still stuck
 * this tick. Extracted for testing; see lastOffset's doc comment (audit A08).
 *
 * Only jumps on the tick's first check (offset started at 0n, so this is the
 * fresh look that confirms the window has not healed since last tick) and
 * only when doing so is actually forward progress - a resume point at or
 * behind `current` (nothing persisted yet, or a market seen for the first
 * time) falls back to the ordinary single-window step.
 */
export function nextStuckOffset(current: bigint, isFirstCheckThisTick: boolean, resumeFrom: bigint, step: bigint): bigint {
  return isFirstCheckThisTick && resumeFrom > current ? resumeFrom : current + step
}

/**
 * Markets that have at least one match actually ready to settle.
 *
 * Sprint 5.6 - was `WHERE status = 'OPEN'`, which could never settle anything.
 *
 * A market's close_time is open_time + duration: the point after which it
 * stops accepting new bets. A match's settle_at is matched_at + duration.
 * Since every match is created after its market opened, settle_at is ALWAYS
 * later than close_time - by exactly however long the market had been open
 * when the match formed. Meanwhile marketCreator.closeExpiredMarkets() flips
 * the row to 'CLOSED' at close_time. So by the time any match became ready,
 * its market had already left the set this query returned, and the keeper
 * settled nothing, ever. Funds sat until SETTLE_GRACE (24h) expired and then
 * could only be emergency-refunded.
 *
 * Confirmed on-chain 2026-07-25: market opened 18:00:42, closed 18:05:42,
 * its only match matched at 18:02:48 and was due at 18:07:48 - two minutes
 * after the market stopped being 'OPEN'.
 *
 * The correct predicate has nothing to do with whether a market still takes
 * bets: settle the markets that own an unsettled, due match. The upper bound
 * skips matches already past SETTLE_GRACE, where the contract reverts with
 * "settlement window expired" - those are refundExpired's job, and retrying
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
      // Skim once before doing any tx work - avoid paying RPC for nothing.
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
      //
      // Always starts at 0n, not lastOffset.get(market): iteration 0 below
      // needs its own first look at the true head every tick to notice a
      // stuck window healing. See lastOffset's doc comment (audit A08) for
      // how this tick's progress still reaches past a long-stuck run.
      let offset = 0n

      for (let i = 0; i < MAX_LOOPS; i++) {
        const ready = await publicClient.readContract({
          address: market, abi: MARKET_VIEW_ABI,
          functionName: 'getReadySettlements',
          args: [canPaginate ? offset : 0n, BigInt(MAX_PER_TX)],
        })
        if (ready.length === 0) {
          if (!canPaginate) break // no way to step past a window on this resolver
          // Empty here does NOT mean nothing is ready further out. It
          // equally means this window's matches already settled on an
          // earlier iteration while a permanently-stuck match still pins the
          // head (see the offset comment above) - offset resets to 0 on
          // every success below, so a growing settled stretch between the
          // stuck head and the fresh frontier used to hide the fresh matches
          // behind an ever-larger "nothing here" window that this loop gave
          // up on. Stepping past it costs one free view call; breaking here
          // is what let one stuck match hide an unbounded amount behind it.
          offset += BigInt(MAX_PER_TX)
          continue
        }

        const encoded = canPaginate
          ? encodeFunctionData({
              abi:          ORACLE_RESOLVER_BATCH_ABI,
              functionName: 'resolveOrderbookMarketBatchFrom',
              args:         [market, offset, BigInt(MAX_PER_TX)],
            })
          : encodeFunctionData({
              abi:          ORACLE_RESOLVER_BATCH_ABI,
              functionName: 'resolveOrderbookMarketBatch',
              args:         [market, BigInt(MAX_PER_TX)],
            })

        // PoolOracleResolver reads the pool itself, so there is no payload to
        // append - and fetching one would fail first anyway: feedId is a pool
        // address there, and fetchOraclePayload decodes it as UTF-8 to get a
        // RedStone symbol, which would ask the gateway for a feed made of
        // address bytes.
        const settleCallData = CHAIN_PROFILE.oraclePayloadInCalldata
          ? withPayload(encoded, await fetchOraclePayload(feedId as `0x${string}`))
          : encoded

        // Simulate first. Gas is pinned at 1.8M below, so a revert burns the
        // entire 1.8M - and this loop runs every 60s and retries MAX_LOOPS
        // times, because `ready` is still non-empty after a failed settle.
        // That turns one recurring revert into ~14.4M wasted gas per minute,
        // indefinitely. Measured on Sepolia at ~0.0044 ETH/hour before this
        // check existed.
        //
        // Unlike the Pyth push in onchainPriceRecorder, there is no known
        // benign revert here, so a failed simulation genuinely means "don't
        // send". The common real cause is a young deployment whose
        // OracleResolver.priceHistory has too few points for _getTWAP to cover
        // the window - legitimate, transient, and exactly what should not cost
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
          //
          // This is iteration 0's first look at the window (offset started at
          // 0n this tick), so confirming it is still stuck here also confirms
          // it has not healed since last tick - safe to resume from wherever
          // a previous tick's walk already reached, in one jump, rather than
          // re-stepping past the same prefix one window at a time (audit A08).
          const stuckAt = offset
          const resume = lastOffset.get(market) ?? 0n
          offset = nextStuckOffset(offset, i === 0, resume, BigInt(MAX_PER_TX))
          console.warn(
            `[resolver] ${market}: ${ready.length} ready match(es) at offset ${stuckAt} ` +
            `cannot settle yet - stepping past them to offset ${offset}`,
          )
          continue
        }

        // Critical: never blocked by the fee ceiling or the daily budget.
        // Somebody's stake is sitting in a market that already resolved, and
        // no gas price makes leaving it there the cheaper option. The call is
        // here for the warning it logs and for the spend accounting below.
        await gasGuard.check('critical')

        // Sized to the batch, not a flat 1.8M - see settlementGas.ts. Base
        // keeps the old fixed ceiling exactly (unmeasured and unchanged by
        // this session); RHC's measured per-match cost means a batch of
        // 13+ matches - which one busy order can approach on its own -
        // needs more than 1.8M, and a smaller batch does not need that much.
        const gasLimit = CHAIN_PROFILE.name === 'rhc'
          ? settlementGasLimit(ready.length, RHC_SETTLEMENT_GAS)
          : 1_800_000n

        const hash = await sendKeeperTx(fees => wallet.sendTransaction({
          to:   CONTRACTS.ORACLE_RESOLVER as Address,
          data: settleCallData,
          gas:  gasLimit,
          ...fees,
        }), 'settle')
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        await recordReceipt(receipt, 'critical')

        // waitForTransactionReceipt resolves for reverted transactions too -
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

      // Remember this tick's progress for the next one - see lastOffset's
      // doc comment (audit A08). Zero is worth storing too: it means this
      // tick either never hit a stuck window or watched one clear, and an
      // absent entry would otherwise read as "no progress yet" instead of
      // "confirmed healthy", the same distinction the loop above draws.
      lastOffset.set(market, offset)
    } catch (err) {
      console.error(`[resolver] market ${market} failed:`, err)
    }
  }
}

// ── OVERDUE MATCHES: nobody was calling emergencyRefundMatch ──────
/**
 * Sweep matches more than SETTLE_GRACE overdue and call the market's own
 * permissionless emergencyRefundMatch on each.
 *
 * Nothing else did this. A match the resolver can never settle - a pool
 * that died under the position, or one that keeps failing the internal
 * spread guard - sits in the settlement queue forever once it passes
 * SETTLE_GRACE: settlePendingMarkets above steps PAST it (so newer matches
 * stay reachable) but never claims the refund that would let the market's
 * own pendingSettlementsHead advance past it, so the stretch of
 * already-settled matches between the stuck head and the fresh frontier
 * only grows, tick over tick. This is what actually bounds that growth:
 * once a match is old enough that emergencyRefundMatch is the only valid
 * outcome left for it, do that, rather than waiting on a human to notice
 * and call it by hand. Applies to both chain profiles - OrderbookMarket's
 * SETTLE_GRACE and emergencyRefundMatch are the shared contract, and a
 * stuck match costs a real user their stake either way.
 */
const OVERDUE_GRACE_SECONDS = 24 * 60 * 60 // OrderbookMarket.SETTLE_GRACE
const OVERDUE_BUFFER_SECONDS = 10 * 60 // clock skew + query latency margin
const OVERDUE_BATCH_LIMIT = Number(process.env.OVERDUE_REFUND_LIMIT ?? '20')

async function overdueMatches(): Promise<Array<{ market: Address; matchId: bigint }>> {
  const r = await pg.query(
    `SELECT market_address, match_id
       FROM matches
      WHERE settled = FALSE
        AND settle_at <= NOW() - make_interval(secs => $1)
      ORDER BY settle_at ASC
      LIMIT $2`,
    [OVERDUE_GRACE_SECONDS + OVERDUE_BUFFER_SECONDS, OVERDUE_BATCH_LIMIT],
  )
  return r.rows.map((x) => ({ market: x.market_address as Address, matchId: BigInt(x.match_id) }))
}

export async function refundOverdueMatches() {
  const wallet = getKeeperWalletClient()
  if (!wallet) return

  const candidates = await overdueMatches()
  for (const { market, matchId } of candidates) {
    try {
      const data = encodeFunctionData({
        abi: MARKET_REFUND_ABI,
        functionName: 'emergencyRefundMatch',
        args: [matchId],
      })

      // Simulate first. The DB can be a tick stale - already refunded by a
      // user, or by this same sweep a moment ago - and OrderbookMarket
      // reverts "already settled" harmlessly for that; a free read already
      // tells us that without spending real gas to discover it on-chain.
      try {
        await publicClient.call({ account: wallet.account, to: market, data })
      } catch (simErr: any) {
        console.warn(
          `[overdueRefund] ${market} match ${matchId}: would revert, skipping ` +
          `(${simErr?.shortMessage ?? simErr?.message ?? 'unknown'})`,
        )
        continue
      }

      // Critical, same reasoning as settlement: a match this old has no
      // path left except this one, and leaving it stuck costs someone their
      // stake indefinitely.
      await gasGuard.check('critical')

      // Measured on-chain (DEPLOYMENTS.md): 143,875 gas. Margin above that.
      const hash = await sendKeeperTx(fees => wallet.sendTransaction({
        to: market, data, gas: 220_000n, ...fees,
      }), 'emergencyRefund')
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      await recordReceipt(receipt, 'critical')

      if (receipt.status === 'success') {
        console.log(`[overdueRefund] ${market} match ${matchId} refunded tx=${hash}`)
      } else {
        console.error(`[overdueRefund] ${market} match ${matchId}: refund tx reverted on-chain, tx=${hash}`)
      }
    } catch (err) {
      console.error(`[overdueRefund] ${market} match ${matchId} failed:`, err)
    }
  }
}
