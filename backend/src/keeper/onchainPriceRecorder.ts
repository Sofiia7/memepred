import { createPublicClient, http, encodeFunctionData, type Address } from 'viem'
import { base, baseSepolia } from 'viem/chains'
const chain = process.env.CHAIN_ID === '8453' ? base : baseSepolia
import { FEED_IDS, ORACLE_RESOLVER_ABI, CONTRACTS } from '../config.js'
import { fetchPayload, withPayload } from '../lib/redstone.js'
import { getKeeperWalletClient } from './keeperWallet.js'
import { gasGuard, recordReceipt } from './gasGuardInstance.js'
import { lastUserActivityMs } from '../lib/activity.js'
import { pg } from '../db/pg.js'

const publicClient = createPublicClient({ chain, transport: http(process.env.BASE_RPC_URL) })

// ── IDLE BACKOFF (Sprint 5.6) ───────────────────────────────
// What this loop is actually for, now that the bare `placeBet` overload is
// gone and every bet carries its own Pyth update: it is the TWAP feed.
// OracleResolver.recordPrice appends to priceHistory[feedId], and settlement
// reads the exit price as a TWAP over a window scaled to the market's own
// duration (MIN_TWAP_WINDOW 30s, TWAP_WINDOW_CAP 5m). Sparse recording means a
// thin window and a worse exit price — so this is settlement infrastructure,
// not entry-price infrastructure.
//
// At two feeds a flat 30s cadence is 5,760 transactions a day, paid whether
// anyone is using the product or not. So: fast cadence whenever it could
// matter, slow heartbeat otherwise.
//
// "Could matter" deliberately includes any PENDING or MATCHED order, not just
// live user traffic — an unsettled match is exactly the case that will need a
// dense TWAP when its settleAt arrives, possibly long after the last human
// left. shouldUseFastCadence() below encodes that.
//
// The heartbeat is not optional either: oracleWatchdog treats a feed that
// stops updating as a fault.
const IDLE_INTERVAL_MS = Number(process.env.PRICE_IDLE_INTERVAL_MS ?? String(5 * 60_000))
const ACTIVITY_WINDOW_MS = Number(process.env.PRICE_ACTIVITY_WINDOW_MS ?? String(15 * 60_000))

let lastPushAt = 0

/**
 * Nothing to pre-flight any more.
 *
 * This used to make two reads before every push, and both were about Pyth:
 * that OracleResolver held ETH to pay Pyth's update fee, and that the Pyth
 * contract it pointed at actually answered. RedStone charges nothing and is
 * verified inside our own contract, so there is no fee to fund and no oracle
 * address to be wrong.
 *
 * Leaving the balance check in place after the migration was worse than
 * useless: it blocked every price push on a resolver balance that no longer
 * matters, which is exactly the outage it was written to prevent, arrived at
 * from the other direction.
 *
 * The failure modes that remain announce themselves earlier and more cheaply -
 * a gateway that will not serve makes fetchPayload throw before any gas is
 * spent, and an empty keeper wallet is the watchdog's job.
 */

/**
 * True when the fast cadence is worth paying for.
 *
 * Two independent triggers. A recent API hit means someone is here and may be
 * about to bet. An order still PENDING or MATCHED means there is unsettled
 * money on the books whose exit TWAP is still being accumulated — that one
 * matters even with nobody watching, and it is also what keeps this correct
 * when Redis is unavailable and the presence signal is simply absent.
 */
async function shouldUseFastCadence(): Promise<boolean> {
  const last = await lastUserActivityMs()
  if (last !== null && Date.now() - last < ACTIVITY_WINDOW_MS) return true

  try {
    const r = await pg.query(
      `SELECT 1 FROM orders
        WHERE status IN ('PENDING', 'MATCHED')
           OR placed_at > NOW() - make_interval(secs => $1)
        LIMIT 1`,
      [Math.round(ACTIVITY_WINDOW_MS / 1000)],
    )
    if ((r.rowCount ?? 0) > 0) return true
  } catch (err) {
    // Can't tell → assume active. Overpaying for gas is a far cheaper
    // failure than a stale oracle blocking bets or settlement.
    console.error('[onchainPriceRecorder] activity check failed, staying hot:', err)
    return true
  }

  return false
}

/**
 * Fetch Pyth Hermes price updates and submit them on-chain to OracleResolver.
 * Must be called by an address with KEEPER_ROLE.
 * Submits with msg.value = pyth.getUpdateFee(); OracleResolver holds an ETH
 * balance for this purpose (top up from treasury).
 */
export async function recordPricesOnChain() {
  const wallet = getKeeperWalletClient()
  if (!wallet) { console.warn('KEEPER_PRIVATE_KEY missing — skipping on-chain price record'); return }
  if (!CONTRACTS.ORACLE_RESOLVER || CONTRACTS.ORACLE_RESOLVER === '0x') {
    console.warn('ORACLE_RESOLVER address missing'); return
  }


  if (!(await shouldUseFastCadence())) {
    // lastPushAt is 0 until the first push of this process, so don't report
    // "idle for 1784992399s" on the startup tick — that's epoch arithmetic,
    // not an outage. Pushing immediately on startup is intended: a fresh
    // process should establish a price before deciding it can coast.
    if (lastPushAt === 0) {
      console.log('[onchainPriceRecorder] idle — initial push on startup')
    } else {
      const sinceLast = Date.now() - lastPushAt
      if (sinceLast < IDLE_INTERVAL_MS) return
      console.log(`[onchainPriceRecorder] idle — heartbeat push after ${Math.round(sinceLast / 1000)}s`)
    }
  }
  // Checked once per tick rather than per feed: if gas is above the ceiling
  // it is above it for every feed, and a price push is the definition of
  // routine work - the next tick is 30 seconds away.
  if (await gasGuard.check('routine')) return

  lastPushAt = Date.now()

  for (const [symbol, feedId] of Object.entries(FEED_IDS)) {
    try {
      // The signed price rides on the calldata rather than in an argument,
      // so this cannot go through writeContract - viem gives no way to append
      // bytes to an encoded call.
      const payload = await fetchPayload(symbol)

      // OracleResolver pays Pyth from its own ETH balance — recordPrice is
      // nonpayable, no `value` argument. Pin gas because Pyth's price-feed
      // update reverts in gas-estimation when the publishTime is already
      // on-chain, which viem can't detect.
      const hash = await wallet.sendTransaction({
        to:   CONTRACTS.ORACLE_RESOLVER as Address,
        data: withPayload(
          encodeFunctionData({
            abi:          ORACLE_RESOLVER_ABI,
            functionName: 'recordPrice',
            args:         [feedId as `0x${string}`],
          }),
          payload,
        ),
        gas: 500_000n,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      await recordReceipt(receipt)
    } catch (err) {
      console.error(`on-chain recordPrice ${symbol} failed:`, err)
    }
  }
}
