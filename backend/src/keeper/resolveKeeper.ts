import { CHAIN_PROFILE } from '../chainProfile.js'
/**
 * resolveKeeper - Sprint 2.1
 *
 * Walks the markets that own a due, unresolved match and batch-resolves their
 * ready matches via OracleResolver.resolveOrderbookMarketBatchFrom, capping
 * per-tx resolutions so each tx stays under a predictable gas ceiling. "Resolved"
 * means a match reached a final state: settled at its exit price, or (on the
 * pool-backed resolver) refunded at once because it can never be priced. The
 * per-market walk - which window to read, when to dry-run, what to remember
 * between ticks - lives in settleScan.ts.
 */
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from 'viem'
import { pg } from '../db/pg.js'
import { CONTRACTS } from '../config.js'
import { fetchPayload, withPayload, bytes32ToFeedId } from '../lib/redstone.js'
import { andMarketInFactory } from '../lib/marketScope.js'
import { getKeeperWalletClient, sendKeeperTx } from './keeperWallet.js'
import { gasGuard, recordReceipt } from './gasGuardInstance.js'
import { BATCH_FROM_SELECTOR, codeHasSelector } from './resolverAbi.js'
import { settlementGasLimit, RHC_SETTLEMENT_GAS } from './settlementGas.js'
import { scanMarketQueue, nextStuckOffset, type ScanIo } from './settleScan.js'
import { AttemptTracker, notParkedSql } from './attemptTracker.js'

// Where this used to be defined, and still imported from here.
export { nextStuckOffset }

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
    // that reached a final state, so one ready-but-unresolvable match at the
    // front pins the window and hides everything behind it; walking the offset
    // is how the rest stays reachable.
    name: 'resolveOrderbookMarketBatchFrom',
    type: 'function',
    stateMutability: 'nonpayable',
    // The price is a calldata suffix, not an argument.
    inputs: [
      { name: 'market',   type: 'address' },
      { name: 'offset',   type: 'uint256' },
      { name: 'maxCount', type: 'uint256' },
    ],
    // Matches that reached a FINAL state: settled or refunded. Not only settled.
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
  {
    // First queue index that is not settled. getReadySettlements offsets are
    // counted from here.
    name: 'pendingSettlementsHead',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    // Next match id to be issued, starting at 1: the queue holds nextMatchId - 1
    // entries, in id order.
    name: 'nextMatchId',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

const publicClient = createPublicClient({
  chain,
  transport: http(CHAIN_PROFILE.rpcUrl),
})

/** Per-tx resolve ceiling. ~25 matches fits comfortably in 1.5M gas. */
const MAX_PER_TX  = Number(process.env.RESOLVE_MAX_PER_TX ?? '25')
/**
 * Per-market, per-tick cap on windows that cost a dry run or a transaction.
 * Prevents runaway.
 */
const MAX_LOOPS   = Number(process.env.RESOLVE_MAX_LOOPS  ?? '8')
/**
 * Per-market, per-tick cap on windows that are only READ because nothing in
 * them is due. A stuck match at the head with a long stretch of already
 * settled matches behind it makes the scan walk that stretch to reach the ones
 * appended after it; a read costs one view call, so this is a separate and
 * much larger budget than MAX_LOOPS (which used to cover both, and could
 * never reach past 200 positions).
 */
const MAX_EMPTY_WINDOWS = Number(process.env.RESOLVE_MAX_EMPTY_WINDOWS ?? '40')

/**
 * Where each market's confirmed-stuck prefix ends, carried across ticks, as an
 * ABSOLUTE index into the market's settlement queue (0 or absent for none).
 *
 * Audit A08 (2026-09-28) added this so that a run of unpriceable matches longer
 * than one tick's budget was not re-discovered window by window on every tick.
 * Its first version stored how far each tick had WALKED, empty windows and all,
 * so the value grew by up to 175 a tick until it pointed past the end of the
 * queue and a match appended behind the stuck head was never read again
 * (audit follow-up 2026-09-28, section 4.1). What is stored now is only what
 * settleScan.ts vouches for, and the rules for that live there.
 *
 * In-process only, not persisted: a restart re-learns the same prefix at the
 * bounded per-tick cost this always had.
 */
const stuckPrefixEnd = new Map<Address, bigint>()

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
  // On rhc only markets of the CURRENT factory: the resolver this keeper calls
  // is the current one, and a market from an earlier deployment answers it
  // `only resolver`, so every tick would burn a dry run per stuck match there.
  const r = await pg.query(`
    SELECT DISTINCT mt.market_address
    FROM matches mt
    WHERE mt.settled = FALSE
      AND mt.settle_at <= NOW()
      AND mt.settle_at >  NOW() - make_interval(hours => $1)${andMarketInFactory('mt.market_address')}
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

/** What the scan needs from one market, wired to the real chain, resolver and wallet. */
function buildScanIo(args: {
  market: Address
  feedId: `0x${string}`
  canPaginate: boolean
  wallet: NonNullable<ReturnType<typeof getKeeperWalletClient>>
  /** The head window, already read by the caller's skim - reused once instead of read twice. */
  firstWindow: readonly bigint[]
}): ScanIo {
  const { market, feedId, canPaginate, wallet } = args
  let firstWindow: readonly bigint[] | null = args.firstWindow
  // The calldata a dry run was made with, kept for the send that follows it.
  // With a RedStone payload that is signed price data with its own timestamp,
  // so a send must carry the payload that was simulated, not a fresh one.
  let prepared: { offset: bigint; data: Hex } | null = null

  async function calldataFor(offset: bigint): Promise<Hex> {
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
    return (CHAIN_PROFILE.oraclePayloadInCalldata
      ? withPayload(encoded, await fetchOraclePayload(feedId))
      : encoded) as Hex
  }

  return {
    async queue() {
      try {
        const [head, next] = await Promise.all([
          publicClient.readContract({ address: market, abi: MARKET_VIEW_ABI, functionName: 'pendingSettlementsHead' }),
          publicClient.readContract({ address: market, abi: MARKET_VIEW_ABI, functionName: 'nextMatchId' }),
        ])
        // pendingSettlements only ever grows by pushing nextMatchId++, and ids
        // start at 1, so its length is nextMatchId - 1.
        return { head, length: next > 0n ? next - 1n : 0n }
      } catch (err: any) {
        // Either a market whose bytecode predates these getters, or an RPC that
        // failed just now. The scan copes without them: it cannot tell where the
        // queue ends, so it remembers nothing between ticks and starts over from
        // the head after every send. Better than not settling at all.
        if (!warnedNoQueueGetters.has(market)) {
          warnedNoQueueGetters.add(market)
          console.warn(
            `[resolver] ${market}: cannot read the settlement queue bounds ` +
            `(${err?.shortMessage ?? err?.message ?? 'unknown'}) - scanning without them`,
          )
        }
        return { head: 0n, length: null }
      }
    },

    async readWindow(offset) {
      if (offset === 0n && firstWindow) {
        const w = firstWindow
        firstWindow = null
        return [...w]
      }
      const ready = await publicClient.readContract({
        address: market, abi: MARKET_VIEW_ABI,
        functionName: 'getReadySettlements',
        args: [canPaginate ? offset : 0n, BigInt(MAX_PER_TX)],
      })
      return [...ready]
    },

    // Simulate first. Gas is pinned when sending, so a revert burns the whole
    // ceiling - and the scan retries per window and per tick, because `ready`
    // is still non-empty after a failed settle. That turns one recurring revert
    // into millions of wasted gas a minute, indefinitely. Measured on Sepolia
    // at ~0.0044 ETH/hour before this check existed.
    //
    // Unlike the Pyth push in onchainPriceRecorder, there is no known benign
    // revert here, so a failed simulation genuinely means "don't send". The
    // common real cause is a young deployment whose OracleResolver.priceHistory
    // has too few points for _getTWAP to cover the window - legitimate,
    // transient, and exactly what should not cost a full gas ceiling a minute
    // to rediscover.
    async simulate(offset) {
      const data = await calldataFor(offset)
      try {
        // publicClient.call rather than simulateContract: the latter encodes
        // the call itself, leaving nowhere to append the signed price, so it
        // would simulate a call the chain would never see and always revert.
        const sim = await publicClient.call({
          account: wallet.account,
          to:      CONTRACTS.ORACLE_RESOLVER as Address,
          data,
        })
        // The batch returns how many matches reached a FINAL state: settled,
        // or refunded because they can never be priced (PoolOracleResolver
        // refunds those at once instead of leaving them locked for a day).
        // Reading it here is what separates "this window has work" from "this
        // window has matches the resolver will skip" - the two used to be
        // indistinguishable, so a skipped window was re-sent over and over and
        // logged as a success every time. A window whose matches would all be
        // refunded is work and must be sent.
        const would = decodeFunctionResult({
          abi:          ORACLE_RESOLVER_BATCH_ABI,
          functionName: canPaginate ? 'resolveOrderbookMarketBatchFrom' : 'resolveOrderbookMarketBatch',
          data:         sim.data ?? '0x',
        }) as bigint
        prepared = { offset, data }
        return would
      } catch (simErr: any) {
        console.warn(
          `[resolver] ${market}: settle would revert, skipping ` +
          `(${simErr?.shortMessage ?? simErr?.message ?? 'unknown'})`,
        )
        return null
      }
    },

    async send(offset, ready, expected) {
      const data = prepared !== null && prepared.offset === offset ? prepared.data : await calldataFor(offset)

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
        data,
        gas:  gasLimit,
        ...fees,
      }), 'settle')
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      await recordReceipt(receipt, 'critical')

      // waitForTransactionReceipt resolves for reverted transactions too -
      // it waits for inclusion, not for success. Without this check the loop
      // logged "resolved N" for a transaction that resolved nothing, then
      // retried it every window.
      if (receipt.status !== 'success') {
        console.error(`[resolver] ${market}: settle tx reverted on-chain, tx=${hash}`)
        return false
      }
      // The count the resolver reported, not the number that looked ready.
      console.log(`[resolver] ${market} resolved ${expected} (settled or refunded) tx=${hash}`)
      return true
    },
  }
}

const warnedNoQueueGetters = new Set<string>()

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
      if (initialReady.length === 0) {
        // Nothing is due at the head (the DB was a tick behind), and so nothing
        // is due anywhere. Whatever was remembered about a stuck prefix is moot.
        stuckPrefixEnd.delete(market)
        continue
      }

      const feedId = await publicClient.readContract({
        address: market, abi: MARKET_VIEW_ABI, functionName: 'feedId',
      })
      const canPaginate = await resolverPaginates()

      const r = await scanMarketQueue(
        buildScanIo({ market, feedId: feedId as `0x${string}`, canPaginate, wallet, firstWindow: initialReady }),
        {
          step:            BigInt(MAX_PER_TX),
          maxLoops:        MAX_LOOPS,
          maxEmptyWindows: MAX_EMPTY_WINDOWS,
          canPaginate,
          resume:          stuckPrefixEnd.get(market) ?? 0n,
        },
      )

      // Remember only what the scan vouched for - see settleScan.ts. Zero is
      // "nothing stuck that is known to lie behind us", so the entry goes.
      if (r.resume > 0n) stuckPrefixEnd.set(market, r.resume)
      else stuckPrefixEnd.delete(market)

      if (r.stuckWindows > 0) {
        console.warn(
          `[resolver] ${market}: ${r.stuckWindows} window(s) of due matches cannot be resolved right now ` +
          `and were stepped past (confirmed-stuck prefix ends at queue position ${r.resume}); ` +
          `they stay in the queue and become refundable by anyone once SETTLE_GRACE lapses`,
        )
      }
      if (r.stop === 'empty-cap') {
        console.warn(
          `[resolver] ${market}: read ${r.emptyWindows} empty window(s) past a stuck match without reaching the end ` +
          `of the queue - matches appended behind that stretch are NOT being reached this tick. It clears when ` +
          `the stuck match is refunded (raise RESOLVE_MAX_EMPTY_WINDOWS to reach further)`,
        )
      } else if (r.stop === 'no-pagination') {
        // No way to step past this window on the deployed resolver. Stopped
        // rather than re-send a batch that resolves nothing every loop.
        console.warn(
          `[resolver] ${market}: due match(es) at the head cannot be resolved yet ` +
          `and this resolver cannot page past them`,
        )
      }
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
 * that died under the position, one whose refund keeps failing - sits in the
 * settlement queue forever once it passes SETTLE_GRACE: settlePendingMarkets
 * above steps PAST it (so newer matches stay reachable) but never claims the
 * refund that would let the market's own pendingSettlementsHead advance past
 * it, so the stretch of already-settled matches between the stuck head and
 * the fresh frontier only grows, tick over tick. This is what actually bounds
 * that growth: once a match is old enough that emergencyRefundMatch is the
 * only valid outcome left for it, do that, rather than waiting on a human to
 * notice and call it by hand. Applies to both chain profiles - OrderbookMarket's
 * SETTLE_GRACE and emergencyRefundMatch are the shared contract, and a
 * stuck match costs a real user their stake either way.
 *
 * (On the pool-backed resolver most unpriceable matches no longer get this
 * far: it refunds them itself, right after settleAt. This remains the backstop
 * for a resolver nobody called and for the "no liquidity, retry later" case.)
 *
 * The oldest OVERDUE_BATCH_LIMIT rows are taken each tick, so a row whose refund
 * cannot go through (a paused market, a callback that reverts) would be the
 * oldest one every time and hold its slot forever. Attempts that make no
 * progress are counted and, after OVERDUE_MAX_ATTEMPTS, the row sits out of the
 * selection for OVERDUE_COOLDOWN_MS - see attemptTracker.ts.
 */
const OVERDUE_GRACE_SECONDS = 24 * 60 * 60 // OrderbookMarket.SETTLE_GRACE
const OVERDUE_BUFFER_SECONDS = 10 * 60 // clock skew + query latency margin
const OVERDUE_BATCH_LIMIT = Number(process.env.OVERDUE_REFUND_LIMIT ?? '20')
const OVERDUE_MAX_ATTEMPTS = Number(process.env.OVERDUE_REFUND_MAX_ATTEMPTS ?? '3')
const OVERDUE_COOLDOWN_MS = Number(process.env.OVERDUE_REFUND_COOLDOWN_MS ?? String(6 * 60 * 60_000))
const overdueRefundAttempts = new AttemptTracker({ maxAttempts: OVERDUE_MAX_ATTEMPTS, cooldownMs: OVERDUE_COOLDOWN_MS })

async function overdueMatches(): Promise<Array<{ market: Address; matchId: bigint }>> {
  // Markets of the current factory only on rhc: refunding an old deployment's
  // matches is gas spent on a stack the product has moved off (its users can
  // still call emergencyRefundMatch themselves - it is permissionless).
  const r = await pg.query(
    `SELECT market_address, match_id
       FROM matches
      WHERE settled = FALSE
        AND settle_at <= NOW() - make_interval(secs => $1)
        AND ${notParkedSql('$3')}${andMarketInFactory('market_address')}
      ORDER BY settle_at ASC
      LIMIT $2`,
    [OVERDUE_GRACE_SECONDS + OVERDUE_BUFFER_SECONDS, OVERDUE_BATCH_LIMIT, overdueRefundAttempts.parkedKeys()],
  )
  return r.rows.map((x) => ({ market: x.market_address as Address, matchId: BigInt(x.match_id) }))
}

export async function refundOverdueMatches() {
  const wallet = getKeeperWalletClient()
  if (!wallet) return

  const candidates = await overdueMatches()
  for (const { market, matchId } of candidates) {
    const attemptKey = AttemptTracker.keyOf(market, matchId)
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
        parkIfStuck(attemptKey, market, matchId)
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
        overdueRefundAttempts.clear(attemptKey)
        console.log(`[overdueRefund] ${market} match ${matchId} refunded tx=${hash}`)
      } else {
        console.error(`[overdueRefund] ${market} match ${matchId}: refund tx reverted on-chain, tx=${hash}`)
        parkIfStuck(attemptKey, market, matchId)
      }
    } catch (err) {
      console.error(`[overdueRefund] ${market} match ${matchId} failed:`, err)
      parkIfStuck(attemptKey, market, matchId)
    }
  }
}

/** Count an attempt that made no progress, and say so once when it parks the row. */
function parkIfStuck(key: string, market: Address, matchId: bigint) {
  if (overdueRefundAttempts.fail(key)) {
    console.warn(
      `[overdueRefund] ${market} match ${matchId}: ${OVERDUE_MAX_ATTEMPTS} attempts without a refund - ` +
      `leaving it out of the sweep for ${Math.round(OVERDUE_COOLDOWN_MS / 60_000)} min so it stops holding a slot`,
    )
  }
}
