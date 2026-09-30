import 'dotenv/config'
import { recordAllPrices, snapshotProbabilities } from './priceRecorder.js'
import { recordRhcPoolPrices }     from './rhcPriceRecorder.js'
import { refundExpiredOrders }    from './refundExpired.js'
import { indexerTick }            from './indexer.js'
import { recordPricesOnChain }    from './onchainPriceRecorder.js'
import { settlePendingMarkets, refundOverdueMatches } from './resolveKeeper.js'
import { oracleWatchdogTick }     from './oracleWatchdog.js'
import { createMissingMarkets }   from './marketCreator.js'
import { badgeSweepTick } from './badgeSweep.js'
import { invariantTick }          from './invariantMonitor.js'
import { poolWatcherTick }        from './poolWatcher.js'
import { CHAIN_PROFILE }          from '../chainProfile.js'
import { roundsEnabled }          from '../rounds/config.js'
import { runMigrations }          from '../db/migrate.js'
import { pg }                     from '../db/pg.js'
import { redis }                  from '../db/redis.js'

console.log(`Starting FlipTheMeme Keeper on the ${CHAIN_PROFILE.name} profile (chain ${CHAIN_PROFILE.chain.id})…`)

/**
 * A positive interval in milliseconds, or `fallback` when `raw` is missing,
 * blank, or not a positive number.
 *
 * `Number('')` is 0 and `Number('15s')` is NaN - either fed straight to
 * setInterval turns a mistyped env var into a hot loop (0ms/NaN both run as
 * fast as the event loop allows) instead of the intended cadence. `min`
 * additionally floors a value that parsed fine but is unreasonably small.
 */
function positiveIntervalMs(raw: string | undefined, fallback: number, min = 1000): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min) {
    console.warn(`[keeper] ignoring interval "${raw}" (must be a number >= ${min}ms), using ${fallback}ms`)
    return fallback
  }
  return n
}

async function loop(label: string, fn: () => Promise<unknown>, intervalMs: number) {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try { await fn() } catch (err) { console.error(`[${label}] failed:`, err) }
    finally { running = false }
  }
  await tick()
  setInterval(tick, intervalMs)
}

async function start() {
  // A connectivity check, not a connection to hold: pg.connect() checks a
  // client OUT of the pool, and this discarded the return value without
  // ever releasing it - a permanently leaked connection, one pool slot
  // smaller for the rest of the process's life, on every single start.
  // pg.query() checks a client out AND back in on its own.
  await pg.query('SELECT 1')
  await runMigrations()
  await redis.connect()
  console.log('Connected to DB + Redis, migrations applied')

  const started: string[] = []
  const start = async (label: string, fn: () => Promise<unknown>, ms: number) => {
    await loop(label, fn, ms)
    started.push(label)
  }

  // Shared by both profiles. Settlement, refunds, indexing and the invariant
  // check do not care where a price came from.
  await start('probSnapshots',   snapshotProbabilities, 60_000)
  await start('indexer',         indexerTick,           45_000)
  // On RHC a match is priced at its own expiry, so a faster tick does not
  // alter the outcome. It does cut the user-visible delay after expiry while
  // preserving bounded batch settlement.
  const settlementInterval = CHAIN_PROFILE.name === 'rhc'
    ? positiveIntervalMs(process.env.RHC_SETTLEMENT_INTERVAL_MS, 15_000)
    : 60_000
  await start('resolveKeeper',   settlePendingMarkets,  settlementInterval)
  await start('refundExpired',   refundExpiredOrders,   5 * 60_000)
  await start('oracleWatchdog',  oracleWatchdogTick,    90_000)
  await start('invariantMonitor', invariantTick,        60_000)
  // Nothing else ever called emergencyRefundMatch - see its doc comment in
  // resolveKeeper.ts. Slow on purpose: a match only qualifies after 24h+,
  // so there is no urgency to check more than a few times an hour.
  await start(
    'overdueRefund', refundOverdueMatches,
    positiveIntervalMs(process.env.OVERDUE_REFUND_INTERVAL_MS, 10 * 60_000),
  )

  /**
   * The two loops that only make sense when a keeper is responsible for
   * prices, and the one that only makes sense when markets expire.
   *
   * On rhc neither is: a v3 pool keeps its own observation history, so there
   * is nothing to push, and a market has no close time, so there is nothing to
   * roll over. These were the entire recurring cost of the Base design, and
   * not starting them is most of why the rhc profile is affordable.
   */
  if (CHAIN_PROFILE.pushesPricesOnChain) {
    await start('priceRecorder',        recordAllPrices,     30_000)
    await start('onchainPriceRecorder', recordPricesOnChain, 30_000)
  }
  if (CHAIN_PROFILE.rollsOverMarkets) {
    // 30s, not 5 min: while idle this tick creates nothing, and when a visitor
    // arrives it is how fast the 5m and 15m markets come back onto the board.
    await start('marketCreator', createMissingMarkets, positiveIntervalMs(process.env.CREATE_INTERVAL_MS, 30_000))
  }
  /** The rhc counterpart to a feed whitelist: onboard pools worth paying for. */
  if (CHAIN_PROFILE.watchesPools) {
    await start('poolWatcher', poolWatcherTick, positiveIntervalMs(process.env.POOL_WATCH_INTERVAL_MS, 60_000))
    // rhc's counterpart to priceRecorder above: nothing else ever wrote to
    // price_history here, so candles and 24h stats had no data to read at
    // all (audit A07). Same cadence as priceRecorder for the same reason.
    await start('rhcPriceRecorder', recordRhcPoolPrices, 30_000)
  }
  // Slow on purpose: nothing about a badge is time-critical, and it is the one
  // loop here that mints for cosmetic reasons.
  await start(
    'badgeSweep', badgeSweepTick,
    positiveIntervalMs(process.env.BADGE_SWEEP_INTERVAL_MS, 10 * 60_000),
  )
  // PoolRounds (backend/src/rounds, docs/rhc/ROUNDS-KEEPER.md). Off unless
  // ROUNDS_ENABLED=true; while off, the module is not even loaded.
  if (roundsEnabled()) await (await import('../rounds/index.js')).startRoundsKeeper(start)

  // Listing what actually started, rather than a hardcoded sentence that would
  // keep claiming a price recorder on a chain that has none.
  console.log(`Keeper running on ${CHAIN_PROFILE.name}: ${started.join(', ')}`)
}

start().catch((err) => {
  console.error('Keeper failed to start:', err)
  process.exit(1)
})
