import { createPublicClient, http, type Address } from 'viem'
import { base, baseSepolia } from 'viem/chains'
const chain = process.env.CHAIN_ID === '8453' ? base : baseSepolia
import { FEED_IDS, PYTH_HERMES, ORACLE_RESOLVER_ABI, CONTRACTS } from '../config.js'
import { getKeeperWalletClient } from './keeperWallet.js'
import { lastUserActivityMs } from '../lib/activity.js'
import { pg } from '../db/pg.js'

const publicClient = createPublicClient({ chain, transport: http(process.env.BASE_RPC_URL) })

// ── IDLE BACKOFF (Sprint 5.6) ───────────────────────────────
// This loop is called every 30s by the keeper so that a bare `placeBet` always
// finds an on-chain price younger than OrderbookMarket.ENTRY_MAX_PRICE_AGE
// (45s). At two feeds that is 5,760 transactions a day, paid identically
// whether anyone is using the product or not — with no users it was the
// single largest ongoing cost after market creation.
//
// So: keep the 30s cadence whenever a human is around, and drop to a slow
// heartbeat when nobody is. Safety of the cold-start case is covered in
// lib/activity.ts — in short, loading the app re-arms the fast cadence within
// one tick, and the frontend's primary bet path (`placeBetWithPyth`) carries
// its own fresh Pyth update and never depends on this loop at all.
//
// The heartbeat is not optional: oracleWatchdog treats a feed that stops
// updating as a fault, and a market that sits unpriced for hours is not a
// state worth being in even when idle.
const IDLE_INTERVAL_MS = Number(process.env.PRICE_IDLE_INTERVAL_MS ?? String(5 * 60_000))
const ACTIVITY_WINDOW_MS = Number(process.env.PRICE_ACTIVITY_WINDOW_MS ?? String(15 * 60_000))

let lastPushAt = 0

/**
 * True when the fast cadence is worth paying for: either a user hit the API
 * recently, or there is real money on the books. The second check is what
 * makes this safe if Redis is unavailable — an open PENDING order means
 * someone may be about to be matched, and settlement paths must not be
 * starved of prices because a cache was down.
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

  // OracleResolver pays Pyth's update fee out of its own ETH. With a zero
  // balance every recordPrice reverts — and because gas is pinned at 500k
  // below (estimation can't be trusted here, see the comment at the call
  // site), a revert burns the whole 500k rather than a fraction of it. Left
  // alone that is 500k gas every 30s per feed, indefinitely, buying nothing.
  // Cheaper to check the balance once per tick than to pay for the failure.
  try {
    const resolverBal = await publicClient.getBalance({
      address: CONTRACTS.ORACLE_RESOLVER as Address,
    })
    if (resolverBal === 0n) {
      console.error(
        '[onchainPriceRecorder] OracleResolver has 0 ETH — skipping push ' +
        '(every attempt would revert and burn its full pinned gas limit). ' +
        'Top it up; oracleWatchdog is already paging on this.',
      )
      return
    }
  } catch (err) {
    // Can't read the balance → fall through and attempt the push. A missed
    // price is worse than one wasted revert.
    console.error('[onchainPriceRecorder] resolver balance check failed:', err)
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
  lastPushAt = Date.now()

  for (const [symbol, feedId] of Object.entries(FEED_IDS)) {
    try {
      // Hermes binary VAA endpoint (v2/updates/price/latest).
      const url = `${PYTH_HERMES}/v2/updates/price/latest?ids[]=${feedId}&encoding=hex&parsed=false`
      const r   = await fetch(url)
      if (!r.ok) throw new Error(`hermes ${r.status}`)
      const json = await r.json() as { binary: { data: string[] } }
      const updateData = json.binary.data.map(h => (h.startsWith('0x') ? h : `0x${h}`) as `0x${string}`)

      // OracleResolver pays Pyth from its own ETH balance — recordPrice is
      // nonpayable, no `value` argument. Pin gas because Pyth's price-feed
      // update reverts in gas-estimation when the publishTime is already
      // on-chain, which viem can't detect.
      const hash = await wallet.writeContract({
        address:      CONTRACTS.ORACLE_RESOLVER as Address,
        abi:          ORACLE_RESOLVER_ABI,
        functionName: 'recordPrice',
        args:         [feedId as `0x${string}`, updateData],
        gas:          500_000n,
      })
      await publicClient.waitForTransactionReceipt({ hash })
    } catch (err) {
      console.error(`on-chain recordPrice ${symbol} failed:`, err)
    }
  }
}
