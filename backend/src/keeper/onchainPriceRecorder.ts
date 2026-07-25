import { createPublicClient, http, type Address } from 'viem'
import { base, baseSepolia } from 'viem/chains'
const chain = process.env.CHAIN_ID === '8453' ? base : baseSepolia
import { FEED_IDS, PYTH_HERMES, ORACLE_RESOLVER_ABI, CONTRACTS } from '../config.js'
import { getKeeperWalletClient } from './keeperWallet.js'
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
 * Two things must hold before a push is worth sending, because `recordPrice`
 * pins gas at 500k (estimation is unreliable here — see the call site) and a
 * revert therefore burns the whole 500k, not a fraction. Both checks are plain
 * reads and cost nothing on-chain.
 *
 *  1. OracleResolver holds ETH. It pays Pyth's update fee from its own
 *     balance; at zero, every push reverts.
 *  2. The Pyth contract it points at actually responds. `OracleResolver.pyth`
 *     is IMMUTABLE, so a wrong address cannot be corrected without redeploying
 *     the whole stack — and a wrong address fails silently in the worst way,
 *     as a revert per push, forever.
 *
 * (2) exists because of a real incident: `.env` carried Pyth's Base MAINNET
 * address with the note "same address on Sepolia". It is not. On Base Sepolia
 * that address holds a 708-byte stub reverting "unsupported" on every call, so
 * every Sepolia deployment had a dead price path — no bare placeBet, no
 * settlement — while the keeper paid 500k gas per attempt to discover it. A
 * one-call liveness probe turns that into a log line.
 */
async function preflightOk(): Promise<boolean> {
  try {
    const bal = await publicClient.getBalance({
      address: CONTRACTS.ORACLE_RESOLVER as Address,
    })
    if (bal === 0n) {
      console.error(
        '[onchainPriceRecorder] OracleResolver has 0 ETH — skipping push; ' +
        'every attempt would revert and burn its full pinned gas limit. ' +
        'oracleWatchdog is already paging on this.',
      )
      return false
    }
  } catch (err) {
    // Can't read → attempt anyway. A missed price is worse than one wasted revert.
    console.error('[onchainPriceRecorder] resolver balance check failed:', err)
    return true
  }

  try {
    const pythAddr = await publicClient.readContract({
      address:      CONTRACTS.ORACLE_RESOLVER as Address,
      abi:          [{ name: 'pyth', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const,
      functionName: 'pyth',
    })
    await publicClient.readContract({
      address:      pythAddr as Address,
      abi:          [{ name: 'getValidTimePeriod', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }] as const,
      functionName: 'getValidTimePeriod',
    })
  } catch {
    console.error(
      '[onchainPriceRecorder] CONFIG ERROR: OracleResolver.pyth() does not ' +
      'answer getValidTimePeriod() — wrong Pyth address for this chain. The ' +
      'address is immutable, so this needs a redeploy, not an env change. ' +
      'Skipping pushes until then rather than burning 500k gas per attempt.',
    )
    return false
  }

  return true
}

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

  if (!(await preflightOk())) return

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
